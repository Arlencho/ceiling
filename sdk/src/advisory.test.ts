import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey, Transaction, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import type { PurposeCheckContext } from "./advisory.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate } from "./read.js";
import {
  TOKEN_PROGRAM,
  encodeBase58,
  framed,
  legacyChargeTx,
  paidLog,
  world,
  type FakeConnection,
} from "./testkit.js";

const MEMO_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const PREFIX = "veto-advisory:v1";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function preloadPaid(w: ReturnType<typeof world>, amount: bigint, nonce: bigint): void {
  w.fake.signature = "sig-charge";
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.transactions.set(
    "sig-charge",
    legacyChargeTx({
      signature: "sig-charge",
      slot: 90,
      blockTime: 1_700_000_000,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)]),
      amount,
      nonce,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledger,
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
}

function chargeInstruction(raw: Buffer | undefined) {
  assert.ok(raw);
  const tx = Transaction.from(raw);
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0];
  assert.ok(ix);
  return { tx, ix };
}

test("an allowed purpose check submits the charge and no memo", async () => {
  const w = world();
  const amount = 500n;
  const nonce = 2n;
  preloadPaid(w, amount, nonce);
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    mandate: w.mandate,
    purposeCheck: async () => ({ allow: true, reason: "matches the rule" }),
  });
  const outcome = await veto.chargeWithPurposeCheck({ amount, nonce, description: "spot top-up" });
  assert.equal(outcome.kind, "paid");
  assert.equal(w.fake.sent.length, 1);
  const { ix } = chargeInstruction(w.fake.sent[0]);
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
  assert.equal(ix.data.readBigUInt64LE(8), amount);
  assert.equal(ix.data.readBigUInt64LE(16), nonce);
  assert.equal(ix.programId.toBase58() === MEMO_PROGRAM, false);
});

test("the purpose check receives the rule purpose, base units, decimals, payee, mandate, and description", async () => {
  const w = world();
  const amount = 500n;
  const nonce = 2n;
  preloadPaid(w, amount, nonce);
  const seen: { ctx: PurposeCheckContext | null } = { ctx: null };
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    mandate: w.mandate,
    purposeCheck: async (ctx) => {
      seen.ctx = ctx;
      return { allow: true, reason: "matches the rule" };
    },
  });
  await veto.chargeWithPurposeCheck({ amount, nonce, description: "spot top-up" });
  const got = seen.ctx;
  assert.ok(got);
  assert.equal(got.purpose, "Charging top-ups at the SE3 spot rate");
  assert.equal(got.amount, 500n);
  assert.equal(got.decimals, 6);
  assert.equal(got.payee, w.merchant.publicKey.toBase58());
  assert.equal(got.mandate, w.mandate.toBase58());
  assert.equal(got.description, "spot top-up");
});

test("charge submits even when a purpose check would decline", async () => {
  const w = world();
  const amount = 500n;
  const nonce = 2n;
  preloadPaid(w, amount, nonce);
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    mandate: w.mandate,
    purposeCheck: async () => ({ allow: false, reason: "bar tab" }),
  });
  const outcome = await veto.charge({ amount, nonce });
  assert.equal(outcome.kind, "paid");
  assert.equal(w.fake.sent.length, 1);
  const { ix } = chargeInstruction(w.fake.sent[0]);
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
});

test("a declined purpose check sends one agent-signed memo and no charge", async () => {
  const w = world();
  w.fake.signature = "sig-memo";
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    mandate: w.mandate,
    purposeCheck: async () => ({ allow: false, reason: "not the stated purpose" }),
  });
  const outcome = await veto.chargeWithPurposeCheck({
    amount: 500n,
    nonce: 4n,
    description: "a bar tab",
  });
  assert.deepEqual(outcome, {
    kind: "advisory_declined",
    reason: "not the stated purpose",
    signature: "sig-memo",
  });
  assert.equal(w.fake.sent.length, 1);
  const { tx, ix } = chargeInstruction(w.fake.sent[0]);
  assert.equal(ix.programId.toBase58(), MEMO_PROGRAM);
  assert.equal(
    tx.instructions.some((item) => item.programId.equals(PROGRAM_ID)),
    false,
  );
  const mandateKey = ix.keys.find((key) => key.pubkey.equals(w.mandate));
  assert.ok(mandateKey);
  assert.equal(mandateKey.isSigner, false);
  assert.equal(mandateKey.isWritable, false);
  const agentSigned = tx.signatures.some(
    (sig) => sig.publicKey.equals(w.agent.publicKey) && sig.signature !== null,
  );
  assert.equal(agentSigned, true);
  assert.equal(tx.feePayer?.toBase58(), w.agent.publicKey.toBase58());
});

test("a declined purpose check escapes the reason and stores the description hash", async () => {
  const w = world();
  const reason = 'say "no" \\ now\nstop';
  const description = "a bar tab";
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    mandate: w.mandate,
    purposeCheck: async () => ({ allow: false, reason }),
  });
  await veto.chargeWithPurposeCheck({ amount: 500n, nonce: 4n, description });
  const { ix } = chargeInstruction(w.fake.sent[0]);
  const text = ix.data.toString("utf8");
  assert.equal(text.startsWith(PREFIX), true);
  assert.equal(text.includes("\n"), false);
  assert.equal(text.includes('\\"'), true);
  assert.equal(text.includes("\\\\"), true);
  assert.equal(text.includes("\\n"), true);
  const parsed = JSON.parse(text.slice(PREFIX.length)) as {
    mandate: string;
    amount: string;
    nonce: string;
    reason: string;
    description_sha256: string;
  };
  assert.equal(parsed.reason, reason);
  assert.equal(parsed.mandate, w.mandate.toBase58());
  assert.equal(parsed.amount, "500");
  assert.equal(parsed.nonce, "4");
  assert.equal(parsed.description_sha256, sha256(description));
  assert.deepEqual(Object.keys(parsed), [
    "mandate",
    "amount",
    "nonce",
    "reason",
    "description_sha256",
  ]);
});

test("a declined purpose check caps the reason on a utf-8 character boundary", async () => {
  const w = world();
  const reason = `${"a".repeat(255)}😀zzzz`;
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    mandate: w.mandate,
    purposeCheck: async () => ({ allow: false, reason }),
  });
  const outcome = await veto.chargeWithPurposeCheck({
    amount: 1n,
    nonce: 1n,
    description: "overflow",
  });
  assert.equal(outcome.kind, "advisory_declined");
  if (outcome.kind !== "advisory_declined") return;
  const { ix } = chargeInstruction(w.fake.sent[0]);
  const parsed = JSON.parse(ix.data.toString("utf8").slice(PREFIX.length)) as { reason: string };
  assert.equal(parsed.reason, "a".repeat(255));
  assert.equal(outcome.reason, "a".repeat(255));
  assert.equal(Buffer.byteLength(parsed.reason, "utf8") <= 256, true);
  assert.equal(reason.startsWith(parsed.reason), true);
});

test("a purpose check that throws does not submit", async () => {
  const w = world();
  const veto = new VetoAgent({
    connection: w.connection,
    agent: w.agent,
    mandate: w.mandate,
    purposeCheck: async () => {
      throw new Error("endpoint down");
    },
  });
  await assert.rejects(
    () => veto.chargeWithPurposeCheck({ amount: 1n, nonce: 1n, description: "bus" }),
    /endpoint down/,
  );
  assert.equal(w.fake.sent.length, 0);
});

function listed(
  signature: string,
  slot: number,
  blockTime: number,
  err: ConfirmedSignatureInfo["err"] = null,
): ConfirmedSignatureInfo {
  return {
    signature,
    slot,
    err,
    memo: null,
    blockTime,
    confirmationStatus: "confirmed",
  };
}

function memoRpc(args: {
  signature: string;
  slot: number;
  blockTime: number;
  signer: PublicKey;
  mandate: PublicKey;
  memo: string;
  readonlyMandate?: boolean;
  err?: unknown;
}) {
  const keys = [args.signer.toBase58(), args.mandate.toBase58(), MEMO_PROGRAM];
  const readonlyMandate = args.readonlyMandate !== false;
  return {
    slot: args.slot,
    blockTime: args.blockTime,
    meta: { err: args.err ?? null, logMessages: [] },
    transaction: {
      signatures: [args.signature],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: readonlyMandate ? 2 : 0,
        },
        accountKeys: keys,
        instructions: [
          {
            programIdIndex: 2,
            accounts: [0, 1],
            data: encodeBase58(Buffer.from(args.memo, "utf8")),
          },
        ],
      },
    },
  };
}

function advisoryMemo(mandate: PublicKey, amount: string, nonce: string, reason: string, hash: string): string {
  return `${PREFIX}${JSON.stringify({
    mandate: mandate.toBase58(),
    amount,
    nonce,
    reason,
    description_sha256: hash,
  })}`;
}

test("decisionsForMandate counts only the agent-signed advisory memo for that mandate", async () => {
  const w = world();
  const hash = sha256("a bar tab");
  const stranger = Keypair.generate();
  const memo = advisoryMemo(w.mandate, "500", "9", "not the stated purpose", hash);
  w.fake.transactions.set(
    "agent-memo",
    memoRpc({
      signature: "agent-memo",
      slot: 30,
      blockTime: 300,
      signer: w.agent.publicKey,
      mandate: w.mandate,
      memo,
    }),
  );
  w.fake.transactions.set(
    "stranger-memo",
    memoRpc({
      signature: "stranger-memo",
      slot: 20,
      blockTime: 200,
      signer: stranger.publicKey,
      mandate: w.mandate,
      memo,
    }),
  );
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.transactions.set(
    "paid",
    legacyChargeTx({
      signature: "paid",
      slot: 10,
      blockTime: 100,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, 8n, 1n, 8n)]),
      amount: 8n,
      nonce: 1n,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledger,
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
  w.fake.signatures = [listed("agent-memo", 30, 300), listed("stranger-memo", 20, 200), listed("paid", 10, 100)];
  const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize: 3 });
  assert.deepEqual(
    rows.map((row) => row.signature),
    ["paid", "agent-memo"],
  );
  const advisory = rows[1];
  assert.ok(advisory);
  assert.equal(advisory.kind, "advisory_declined");
  assert.equal(advisory.reasonText, "Agent declined (advisory)");
  assert.equal(advisory.advisoryReason, "not the stated purpose");
  assert.equal(advisory.amount, 500n);
  assert.equal(advisory.nonce, 9n);
  assert.equal(advisory.descriptionSha256, hash);
  assert.equal(advisory.mandate, w.mandate.toBase58());
  assert.equal(rows.oldestSignature, "paid");
  assert.equal(rows.pageFull, true);
});

test("a stranger memo is not a decision and does not move the page cursor", async () => {
  const w = world();
  const stranger = Keypair.generate();
  const hash = "ab".repeat(32);
  const memo = advisoryMemo(w.mandate, "1", "2", "nope", hash);
  w.fake.transactions.set(
    "stranger-memo",
    memoRpc({
      signature: "stranger-memo",
      slot: 30,
      blockTime: 300,
      signer: stranger.publicKey,
      mandate: w.mandate,
      memo,
    }),
  );
  w.fake.transactions.set(
    "agent-memo",
    memoRpc({
      signature: "agent-memo",
      slot: 20,
      blockTime: 200,
      signer: w.agent.publicKey,
      mandate: w.mandate,
      memo,
    }),
  );
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.transactions.set(
    "paid",
    legacyChargeTx({
      signature: "paid",
      slot: 10,
      blockTime: 100,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, 8n, 1n, 8n)]),
      amount: 8n,
      nonce: 1n,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledger,
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
  w.fake.signatures = [listed("stranger-memo", 30, 300), listed("agent-memo", 20, 200), listed("paid", 10, 100)];
  const first = await decisionsForMandate(w.connection, w.mandate, { pageSize: 1 });
  assert.equal(first.length, 0);
  assert.equal(first.oldestSignature, "stranger-memo");
  assert.equal(first.pageFull, true);
  const second = await decisionsForMandate(w.connection, w.mandate, {
    pageSize: 1,
    before: first.oldestSignature ?? undefined,
  });
  assert.equal(second.length, 1);
  assert.equal(second[0]?.signature, "agent-memo");
  assert.equal(second[0]?.kind, "advisory_declined");
  assert.equal(second.oldestSignature, "agent-memo");
  const third = await decisionsForMandate(w.connection, w.mandate, {
    pageSize: 1,
    before: second.oldestSignature ?? undefined,
  });
  assert.equal(third.length, 1);
  assert.equal(third[0]?.kind, "paid");
  assert.equal(third[0]?.signature, "paid");
});

test("a malformed advisory memo is ignored", async () => {
  const w = world();
  const other = Keypair.generate().publicKey;
  const hash = "cd".repeat(32);
  const good = advisoryMemo(w.mandate, "7", "3", "kept", hash);
  const cases: { signature: string; memo: string; readonlyMandate?: boolean }[] = [
    { signature: "bad-json", memo: `${PREFIX}{` },
    { signature: "wrong-prefix", memo: `veto-advisory:v2${good.slice(PREFIX.length)}` },
    {
      signature: "extra-key",
      memo: `${PREFIX}${JSON.stringify({
        mandate: w.mandate.toBase58(),
        amount: "7",
        nonce: "3",
        reason: "x",
        description_sha256: hash,
        extra: true,
      })}`,
    },
    { signature: "other-mandate", memo: advisoryMemo(other, "7", "3", "x", hash) },
    {
      signature: "upper-hash",
      memo: advisoryMemo(w.mandate, "7", "3", "x", hash.toUpperCase()),
    },
    { signature: "writable-mandate", memo: good, readonlyMandate: false },
  ];
  cases.forEach((item, index) => {
    w.fake.transactions.set(
      item.signature,
      memoRpc({
        signature: item.signature,
        slot: 100 - index,
        blockTime: 1000 - index,
        signer: w.agent.publicKey,
        mandate: w.mandate,
        memo: item.memo,
        readonlyMandate: item.readonlyMandate,
      }),
    );
  });
  w.fake.transactions.set(
    "good-memo",
    memoRpc({
      signature: "good-memo",
      slot: 1,
      blockTime: 1,
      signer: w.agent.publicKey,
      mandate: w.mandate,
      memo: good,
    }),
  );
  w.fake.signatures = [
    ...cases.map((item, index) => listed(item.signature, 100 - index, 1000 - index)),
    listed("failed-memo", 2, 2, { InstructionError: [0, "Custom"] }),
    listed("good-memo", 1, 1),
  ];
  const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize: 8 });
  assert.deepEqual(
    rows.map((row) => row.signature),
    ["good-memo"],
  );
  assert.equal(rows[0]?.kind, "advisory_declined");
  assert.equal(rows[0]?.advisoryReason, "kept");
  assert.equal(w.fake.opened.includes("failed-memo"), false);
  assert.equal(rows.oldestSignature, "good-memo");
  assert.equal(rows.pageFull, true);
});

test("a page with no memo does not read the mandate account", async () => {
  const w = world();
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.transactions.set(
    "paid",
    legacyChargeTx({
      signature: "paid",
      slot: 10,
      blockTime: 100,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, 8n, 1n, 8n)]),
      amount: 8n,
      nonce: 1n,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledger,
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
  w.fake.signatures = [listed("paid", 10, 100)];
  const reads = countAccountReads(w.fake);
  const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "paid");
  assert.equal(reads.count, 0);
});

function countAccountReads(fake: FakeConnection): { count: number } {
  const seen = { count: 0 };
  const inner = fake.getAccountInfo.bind(fake);
  fake.getAccountInfo = async (key: PublicKey) => {
    seen.count += 1;
    return inner(key);
  };
  return seen;
}
