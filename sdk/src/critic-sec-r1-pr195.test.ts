// Security critic fixtures, PR 195 round 1.
// S1 steers decisionsForMandate into a paid row for a refused charge: open_mandate
// logs the caller's purpose text under Veto's own frame (lib.rs:114), the text
// regex in events.ts:219 is unanchored, and a cut log drops the Refused event.
// S2 is the control: a foreign frame carrying a Veto-shaped line and a valid
// Paid event never attributes. S3 reads a forged account at a caller-supplied
// address. S4 is a stranger's second token account for the merchant. S5 locks
// the secret key and a keyed endpoint out of every error and status surface.
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { decisionsFromTx, viewFromRpc, type RpcTransaction } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda, mandatePda } from "./layout.js";
import { decisionsForMandate, fetchLedger, fetchMandate } from "./read.js";
import {
  TOKEN_PROGRAM,
  chargeData,
  encodeBase58,
  ledgerBytes,
  legacyChargeTx,
  mandateBytes,
  paidLog,
  tokenAccountData,
  world,
} from "./testkit.js";

const PROGRAM = PROGRAM_ID.toBase58();
const OPEN_MANDATE_DISC = Buffer.from([116, 145, 190, 28, 86, 223, 105, 74]);

type W = ReturnType<typeof world>;

function chargeKeys(w: W): PublicKey[] {
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

function listOne(w: W, signature: string, tx: RpcTransaction): void {
  w.fake.signatures = [{ signature, slot: tx.slot ?? 0, err: null, blockTime: tx.blockTime ?? null, memo: null }];
  w.fake.transactions.set(signature, tx);
}

test("S1 open_mandate purpose text under the Veto frame turns a refused charge into a paid row", async () => {
  // The attacker holds the agent key of the victim's mandate V and an owner key of
  // its own. One transaction: a flood instruction that spends the log budget,
  // open_mandate on the attacker's own mandate with purpose "VETO PAID amount=100",
  // then charge(V, 100, 5), which the program refuses (over cap). The budget runs
  // out after the REFUSED msg! and before the emit!, as lib.rs:239 then :248 order
  // them. Only the owner-side reader is deceived; the chain refused.
  const w = world({ spent: 300_000_000n });
  const flood = Keypair.generate().publicKey;
  const attackerOwner = Keypair.generate().publicKey;
  const mandateA = mandatePda(PROGRAM_ID, attackerOwner, 1n);
  const keys = [
    ...chargeKeys(w),
    attackerOwner,
    mandateA,
    ledgerPda(PROGRAM_ID, mandateA),
    Keypair.generate().publicKey,
    SystemProgram.programId,
    flood,
  ];
  const k = keys.map((key) => key.toBase58());
  const logs = [
    `Program ${flood.toBase58()} invoke [1]`,
    ...Array.from({ length: 40 }, () => "Program log: filler filler filler filler filler filler filler filler"),
    `Program ${flood.toBase58()} success`,
    `Program ${PROGRAM} invoke [1]`,
    "Program log: Instruction: OpenMandate",
    `Program ${SystemProgram.programId.toBase58()} invoke [2]`,
    `Program ${SystemProgram.programId.toBase58()} success`,
    `Program ${TOKEN_PROGRAM.toBase58()} invoke [2]`,
    "Program log: Instruction: ApproveChecked",
    `Program ${TOKEN_PROGRAM.toBase58()} success`,
    "Program log: VETO OPENED cap=100 per_tx_max=100 expires_at=1797805739 purpose=VETO PAID amount=100",
    `Program ${PROGRAM} consumed 40000 of 200000 compute units`,
    `Program ${PROGRAM} success`,
    `Program ${PROGRAM} invoke [1]`,
    "Program log: Instruction: Charge",
    "Program log: VETO REFUSED reason=6 (over cap) amount=100 per_tx_max=10000000 remaining=0 override_to_clear=0",
    "Log truncated",
  ];
  const tx: RpcTransaction = {
    slot: 900,
    blockTime: 1_790_300_000,
    meta: { err: null, logMessages: logs },
    transaction: {
      signatures: ["sig-steer"],
      message: {
        accountKeys: k,
        instructions: [
          { programIdIndex: k.indexOf(flood.toBase58()), accounts: [], data: encodeBase58(Buffer.from([9, 9, 9])) },
          {
            programIdIndex: k.indexOf(PROGRAM),
            accounts: [8, 9, 10, 11, 5, 6, 12],
            data: encodeBase58(Buffer.concat([OPEN_MANDATE_DISC, Buffer.alloc(64)])),
          },
          { programIdIndex: k.indexOf(PROGRAM), accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(100n, 5n)) },
        ],
      },
    },
  };
  const direct = decisionsFromTx(viewFromRpc(tx, { signature: "sig-steer", slot: 900 }), PROGRAM, w.mandate.toBase58());
  assert.ok(
    direct.every((row) => row.kind !== "paid"),
    `decisionsFromTx reported ${JSON.stringify(direct.map((r) => [r.kind, r.mandate === w.mandate.toBase58(), r.amount.toString(), r.nonce.toString()]))}`,
  );
  listOne(w, "sig-steer", tx);
  const rows = await decisionsForMandate(w.connection, w.mandate);
  assert.ok(rows.every((row) => row.kind !== "paid"), `decisionsForMandate reported paid for the refused nonce 5`);
});

test("S2 control: a foreign frame with a Veto line and a valid Paid event never attributes to the mandate", async () => {
  const w = world();
  const attacker = Keypair.generate().publicKey;
  const inner = Keypair.generate().publicKey;
  const keys = [...chargeKeys(w), attacker, inner];
  const k = keys.map((key) => key.toBase58());
  const logs = [
    `Program ${attacker.toBase58()} invoke [1]`,
    `Program log: Program ${PROGRAM} invoke [2]`,
    "Program log: VETO PAID amount=7 spent=7 of cap=300000000 remaining=299999993",
    paidLog(w.mandate, 7n, 9n, 7n),
    `Program ${inner.toBase58()} invoke [2]`,
    paidLog(w.mandate, 7n, 9n, 7n),
    `Program ${inner.toBase58()} success`,
    `Program log: Program ${PROGRAM} success`,
    `Program ${attacker.toBase58()} success`,
  ];
  const tx: RpcTransaction = {
    slot: 901,
    blockTime: 1_790_300_100,
    meta: { err: null, logMessages: logs },
    transaction: {
      signatures: ["sig-foreign"],
      message: {
        accountKeys: k,
        instructions: [{ programIdIndex: k.indexOf(attacker.toBase58()), accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(7n, 9n)) }],
      },
    },
  };
  listOne(w, "sig-foreign", tx);
  assert.deepEqual(await decisionsForMandate(w.connection, w.mandate), []);
});

test("S3 a forged account at a caller-supplied address, owned by another program, does not read as a mandate or ledger", async () => {
  const w = world();
  const forger = Keypair.generate().publicKey;
  const fakeMandate = Keypair.generate().publicKey;
  const fakeLedger = Keypair.generate().publicKey;
  const real = w.fake.accounts.get(w.mandate.toBase58());
  assert.ok(real);
  w.fake.accounts.set(fakeMandate.toBase58(), { data: Buffer.from(real.data), owner: forger, lamports: 1 });
  w.fake.accounts.set(fakeLedger.toBase58(), {
    data: ledgerBytes({ mandate: fakeMandate, total: 1, head: 1, bump: 1, entries: [{ index: 0, ts: 1n, amount: 5n, counterparty: w.destination.publicKey, nonce: 1n, suggestedOverride: 0n, kind: 1, reason: 0 }] }),
    owner: forger,
    lamports: 1,
  });
  await assert.rejects(fetchMandate(w.connection, fakeMandate), /owner|owned|program/i);
  await assert.rejects(fetchLedger(w.connection, fakeLedger), /owner|owned|program/i);
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: fakeMandate });
  await assert.rejects(veto.status(), /owner|owned|program/i);
});

test("S4 a stranger's second token account for the merchant does not block charge; the merchant ATA is used", async () => {
  const w = world();
  const ata = getAssociatedTokenAddressSync(w.mint.publicKey, w.merchant.publicKey, false, TOKEN_PROGRAM);
  w.fake.tokenAccounts = [
    { owner: w.merchant.publicKey.toBase58(), mint: w.mint.publicKey.toBase58(), pubkey: ata, data: tokenAccountData(w.mint.publicKey, w.merchant.publicKey) },
    // Anyone can pay the rent for a token account whose owner field is the merchant.
    { owner: w.merchant.publicKey.toBase58(), mint: w.mint.publicKey.toBase58(), pubkey: Keypair.generate().publicKey, data: tokenAccountData(w.mint.publicKey, w.merchant.publicKey) },
  ];
  const keys = chargeKeys(w);
  keys[4] = ata;
  w.fake.signature = "sig-s4";
  w.fake.transactions.set(
    "sig-s4",
    legacyChargeTx({
      signature: "sig-s4",
      slot: 5,
      blockTime: 1_790_300_200,
      logs: [`Program ${PROGRAM} invoke [1]`, paidLog(w.mandate, 1n, 1n, 1n), `Program ${PROGRAM} success`],
      keys,
      amount: 1n,
      nonce: 1n,
    }),
  );
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const outcome = await veto.charge({ amount: 1n, nonce: 1n });
  assert.equal(outcome.kind, "paid");
  const sent = w.fake.sent[0];
  assert.ok(sent);
  assert.ok(sent.includes(ata.toBuffer()), "the destination sent was not the merchant ATA");
});

test("S5 lock: the secret key and a keyed endpoint never reach an error, a status, or the wire", async () => {
  const w = world();
  const endpoint = "https://rpc.example.com/?api-key=SECRET-ENDPOINT-KEY-9f3a";
  const fake = w.fake as unknown as { rpcEndpoint: string; getLatestBlockhash: () => Promise<never>; getTransaction: () => Promise<never> };
  fake.rpcEndpoint = endpoint;
  const secretB58 = encodeBase58(Buffer.from(w.agent.secretKey));
  const secretJson = JSON.stringify(Array.from(w.agent.secretKey));
  const seedHex = Buffer.from(w.agent.secretKey.subarray(0, 32)).toString("hex");
  const leaks = (text: string): string[] =>
    [secretB58, secretJson, seedHex, endpoint, "api-key"].filter((needle) => text.includes(needle));
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const status = await veto.status();
  assert.deepEqual(leaks(JSON.stringify(status, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), []);
  // Default console.log depth. The connection is the caller's object and prints
  // its own endpoint; only key bytes are the SDK's to keep out.
  assert.deepEqual([secretB58, secretJson, seedHex].filter((n) => inspect(veto).includes(n)), [], "inspect(VetoAgent) prints key bytes");
  const seen: string[] = [];
  fake.getLatestBlockhash = async () => {
    throw new Error(`blockhash failed for ${endpoint}`);
  };
  await veto.charge({ amount: 1n, nonce: 1n }).catch((err: unknown) => seen.push(inspect(err, { depth: 6 })));
  fake.getLatestBlockhash = async () => {
    throw new Error("plain");
  };
  w.fake.accounts.delete(w.source.publicKey.toBase58());
  await veto.charge({ amount: 1n, nonce: 1n }).catch((err: unknown) => seen.push(inspect(err, { depth: 6 })));
  assert.equal(seen.length, 2);
  // The endpoint is the caller's own object; the SDK must not add it. The first
  // error wraps a cause that carried it, so only the SDK-authored message is checked.
  assert.deepEqual(leaks(String(seen[1])), []);
  assert.deepEqual([secretB58, secretJson, seedHex].filter((n) => String(seen[0]).includes(n)), []);
  for (const raw of w.fake.sent) {
    assert.ok(!raw.includes(Buffer.from(w.agent.secretKey.subarray(0, 32))), "seed bytes on the wire");
  }
});
