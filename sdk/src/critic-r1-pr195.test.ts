// Backend critic fixtures, PR 195 round 1.
// R1 locks the refusal shape against the devnet log lines the program wrote.
// R2 and R3 are the "no event" shapes: a Veto frame whose event was cut must not
// become a decision from the text line. R4 is the nonce rule from lib.rs:381.
// R5 is the charge account list against the IDL. R6 is the reason table against
// the Rust source. R7 runs viewFromRpc over real web3 Message objects.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { decisionsFromTx, viewFromRpc, type RpcTransaction } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate } from "./read.js";
import { REASON_TEXT } from "./reasons.js";
import { TOKEN_PROGRAM, chargeData, framed, legacyChargeTx, paidLog, refusedLog, world } from "./testkit.js";

const PROGRAM = PROGRAM_ID.toBase58();

// Devnet 4L8V9sX4sV4iE7QXfxHoZbvYVDtgZD6YAA4h8gJJ2iYTHNKumNS4L2F63T5nbm8aEex4kcSFwVqvemTjQoaBjVKt
// on mandate GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG, amount 10000001, nonce 1.
const DEVNET_MANDATE = "GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG";
const DEVNET_LOGS = [
  `Program ${PROGRAM} invoke [1]`,
  "Program log: Instruction: Charge",
  "Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=10000001 per_tx_max=10000000 remaining=300000000 override_to_clear=10000001",
  "Program data: 5jGF0Go+aqnmSQI79NBewazyJ3ux02Rj+lo7Fxze003Dm5QzShqIh4GWmAAAAAAAAQAAAAAAAAAFgZaYAAAAAAA=",
  `Program ${PROGRAM} consumed 12417 of 200000 compute units`,
  `Program ${PROGRAM} success`,
];

function keysFor(w: ReturnType<typeof world>): PublicKey[] {
  return [
    w.agent.publicKey,
    w.mandate,
    ledgerPda(PROGRAM_ID, w.mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM,
    PROGRAM_ID,
  ];
}

function preload(w: ReturnType<typeof world>, logs: string[], amount: bigint, nonce: bigint): void {
  w.fake.signature = "sig-r1";
  w.fake.transactions.set(
    "sig-r1",
    legacyChargeTx({ signature: "sig-r1", slot: 77, blockTime: 1_790_202_460, logs, keys: keysFor(w), amount, nonce }),
  );
}

test("R1 the devnet refusal event decodes to reason 5, its text, and the override that clears it", () => {
  const tx = legacyChargeTx({
    signature: "sig-devnet",
    slot: 503_166_880,
    blockTime: 1_790_202_460,
    logs: DEVNET_LOGS,
    keys: [Keypair.generate().publicKey, new PublicKey(DEVNET_MANDATE), ...Array.from({ length: 5 }, () => Keypair.generate().publicKey), PROGRAM_ID],
    amount: 10_000_001n,
    nonce: 1n,
  });
  const rows = decisionsFromTx(viewFromRpc(tx, { signature: "sig-devnet", slot: 0 }), PROGRAM, DEVNET_MANDATE);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { kind: rows[0]?.kind, reason: rows[0]?.reason, text: rows[0]?.reasonText, override: rows[0]?.suggestedOverride, nonce: rows[0]?.nonce, amount: rows[0]?.amount },
    { kind: "refused", reason: 5, text: "over per-payment maximum", override: 10_000_001n, nonce: 1n, amount: 10_000_001n },
  );
});

test("R2 charge fails loudly when the Veto frame has the text line but no event", async () => {
  // The program logs msg! before emit! (lib.rs:239 then :248). A log budget that
  // ends between the two leaves exactly this frame. Events have existed since the
  // first commit, so a text-only frame on chain means a cut log, not a decision.
  const w = world();
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const amount = 10_000_001n;
  preload(
    w,
    [
      `Program ${PROGRAM} invoke [1]`,
      "Program log: Instruction: Charge",
      `Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=${amount} per_tx_max=10000000 remaining=300000000 override_to_clear=${amount}`,
      "Log truncated",
    ],
    amount,
    1n,
  );
  await assert.rejects(() => veto.charge({ amount, nonce: 1n }), /no attributable Veto decision/);
});

test("R3 decisionsForMandate yields no decision for a frame with a text line and no event", async () => {
  const w = world();
  const logs = [
    `Program ${PROGRAM} invoke [1]`,
    "Program log: VETO PAID amount=500 spent=500 of cap=300000000 remaining=299999500",
    "Log truncated",
  ];
  w.fake.signatures = [
    { signature: "s-cut", slot: 9, err: null, memo: null, blockTime: 1, confirmationStatus: "confirmed" },
  ];
  w.fake.transactions.set(
    "s-cut",
    legacyChargeTx({ signature: "s-cut", slot: 9, blockTime: 1, logs, keys: keysFor(w), amount: 500n, nonce: 3n }),
  );
  const rows = await decisionsForMandate(w.connection, w.mandate);
  assert.deepEqual(rows, []);
});

test("R4 a refused charge leaves nextNonce where it was, and the sent nonce is the one given", async () => {
  const w = world({ lastNonce: 4n });
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const nonce = await veto.nextNonce();
  assert.equal(nonce, 5n);
  preload(w, framed(PROGRAM, [refusedLog(w.mandate, 10_000_001n, nonce, 5, 10_000_001n)]), 10_000_001n, nonce);
  const outcome = await veto.charge({ amount: 10_000_001n, nonce });
  assert.equal(outcome.kind, "refused");
  const ix = Transaction.from(w.fake.sent[0]!).instructions[0]!;
  assert.equal(ix.data.readBigUInt64LE(16), 5n);
  // The fake mandate is the chain after a refusal: last_nonce unchanged (lib.rs:187 is the only write).
  assert.equal(await veto.nextNonce(), 5n);
});

test("R5 the charge account list matches the IDL in order, signer and writable flags", async () => {
  const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../idl/veto.json", import.meta.url)), "utf8")) as {
    instructions: { name: string; accounts: { name: string; writable?: boolean; signer?: boolean }[] }[];
  };
  const spec = idl.instructions.find((item) => item.name === "charge")?.accounts;
  assert.ok(spec);
  const w = world();
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  preload(w, framed(PROGRAM, [paidLog(w.mandate, 7n, 1n, 7n)]), 7n, 1n);
  await veto.charge({ amount: 7n, nonce: 1n });
  const ix = Transaction.from(w.fake.sent[0]!).instructions[0]!;
  const expected = keysFor(w).slice(0, 7);
  assert.equal(ix.keys.length, spec.length);
  spec.forEach((account, i) => {
    const meta = ix.keys[i]!;
    assert.equal(meta.pubkey.toBase58(), expected[i]!.toBase58(), `${account.name} pubkey`);
    assert.equal(meta.isSigner, account.signer === true, `${account.name} signer`);
    // Index 0 is the fee payer; the compiled message marks it writable whatever the IDL says.
    if (i > 0) assert.equal(meta.isWritable, account.writable === true, `${account.name} writable`);
  });
});

test("R6 reason codes and texts match programs/veto/src/state.rs and lib.rs", () => {
  const root = new URL("../../programs/veto/src/", import.meta.url);
  const state = readFileSync(fileURLToPath(new URL("state.rs", root)), "utf8");
  const lib = readFileSync(fileURLToPath(new URL("lib.rs", root)), "utf8");
  const codes = new Map<string, number>();
  for (const m of state.matchAll(/pub const (REASON_[A-Z_]+): u8 = (\d+);/g)) codes.set(m[1]!, Number(m[2]));
  const fromProgram: Record<number, string> = {};
  for (const m of lib.matchAll(/(REASON_[A-Z_]+) => "([^"]*)"/g)) {
    const code = codes.get(m[1]!);
    assert.notEqual(code, undefined, m[1]);
    fromProgram[code!] = m[2]!;
  }
  assert.equal(Object.keys(fromProgram).length, 11);
  for (const [code, text] of Object.entries(fromProgram)) {
    assert.equal(REASON_TEXT[Number(code)], text, `reason ${code}`);
  }
  assert.equal(REASON_TEXT[11], "output account not allowed");
  assert.equal(REASON_TEXT[12], "pool account not allowed");
  assert.equal(REASON_TEXT[13], "over daily limit");
  assert.equal(REASON_TEXT[14], "quote below floor");
  assert.equal(Object.keys(REASON_TEXT).length, 15);
});

test("R7 viewFromRpc reads a real legacy Message and a real MessageV0", () => {
  const w = world();
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: keysFor(w).slice(0, 7).map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i >= 1 && i <= 4 })),
    data: chargeData(9n, 2n),
  });
  const blockhash = Keypair.generate().publicKey.toBase58();
  const legacy = new Transaction({ feePayer: w.agent.publicKey, blockhash, lastValidBlockHeight: 1 }).add(ix).compileMessage();
  const v0 = new TransactionMessage({ payerKey: w.agent.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  for (const message of [legacy, v0]) {
    const tx = {
      slot: 5,
      blockTime: 1,
      meta: { err: null, logMessages: framed(PROGRAM, [paidLog(w.mandate, 9n, 2n, 9n)]) },
      transaction: { signatures: ["sig-msg"], message },
    } as unknown as RpcTransaction;
    const rows = decisionsFromTx(viewFromRpc(tx, { signature: "x", slot: 0 }), PROGRAM, w.mandate.toBase58());
    assert.equal(rows.length, 1, message.constructor.name);
    assert.equal(rows[0]?.counterparty, w.destination.publicKey.toBase58(), message.constructor.name);
    assert.equal(rows[0]?.nonce, 2n);
  }
});
