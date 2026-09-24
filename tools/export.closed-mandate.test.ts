// Issue 204. close_mandate removes the account. Export still has to write the
// decision, with limits from the open that covered that signature, and say so.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { recordFromSignature, recordsFromIndexedDecisions } from "./export.js";
import {
  CHARGE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  parseRecord,
  reasonText,
  recordToJson,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessRecord, type AssessOpts } from "./verify.js";
import type { IndexedDecision } from "./bulk.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const SYSTEM = new PublicKey("11111111111111111111111111111111");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const PER_TX = 500_000n;
const EXPIRES = 1_797_713_870n;
const NOTE = "mandate account is closed and the limits came from the opening transaction";

type Limits = { cap: bigint; purpose: string };

function disc(name: string): Buffer {
  const path = join(dirname(fileURLToPath(import.meta.url)), "idl", "veto.json");
  const idl = JSON.parse(readFileSync(path, "utf8")) as {
    instructions: { name: string; discriminator: number[] }[];
  };
  const ix = idl.instructions.find((item) => item.name === name);
  if (!ix) throw new Error(`missing ${name}`);
  return Buffer.from(ix.discriminator);
}

function encodeOpen(mandateId: bigint, limits: Limits): Buffer {
  const purpose = Buffer.from(limits.purpose, "utf8");
  const buf = Buffer.alloc(8 + 8 + 32 + 32 + 8 + 8 + 8 + 4 + purpose.length);
  let o = 0;
  disc("open_mandate").copy(buf, o);
  o += 8;
  buf.writeBigUInt64LE(mandateId, o);
  o += 8;
  AGENT.toBuffer().copy(buf, o);
  o += 32;
  MERCHANT.toBuffer().copy(buf, o);
  o += 32;
  buf.writeBigUInt64LE(limits.cap, o);
  o += 8;
  buf.writeBigUInt64LE(PER_TX, o);
  o += 8;
  buf.writeBigInt64LE(EXPIRES, o);
  o += 8;
  buf.writeUInt32LE(purpose.length, o);
  o += 4;
  purpose.copy(buf, o);
  return buf;
}

type Charge = {
  signature: string;
  slot: number;
  amount: number;
  nonce: number;
  timestamp: number;
  decision: "paid" | "refused";
};
type Step =
  | { kind: "open"; signature: string; slot: number; limits: Limits }
  | { kind: "close"; signature: string; slot: number }
  | ({ kind: "charge" } & Charge);

function openTx(mandate: PublicKey, ledger: PublicKey, mandateId: bigint, step: Extract<Step, { kind: "open" }>): unknown {
  const keys = [OWNER, mandate, ledger, SOURCE, MINT, TOKEN_PROGRAM_ID, SYSTEM, PROGRAM];
  return {
    slot: step.slot,
    blockTime: step.slot,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [
          {
            programIdIndex: 7,
            accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6],
            data: encodeOpen(mandateId, step.limits),
          },
        ],
      },
    },
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: Instruction: OpenMandate", `Program ${PROGRAM.toBase58()} success`] },
  };
}

function closeTx(mandate: PublicKey, ledger: PublicKey, step: Extract<Step, { kind: "close" }>): unknown {
  const keys = [OWNER, mandate, ledger, PROGRAM];
  return {
    slot: step.slot,
    blockTime: step.slot,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [{ programIdIndex: 3, accountKeyIndexes: [0, 1, 2], data: disc("close_mandate") }],
      },
    },
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: VETO CLOSED", `Program ${PROGRAM.toBase58()} success`] },
  };
}

function chargeLogs(mandate: PublicKey, step: Charge): string[] {
  if (step.decision === "paid") {
    return [
      `Program ${PROGRAM.toBase58()} invoke [1]`,
      "Program log: Instruction: Charge",
      `Program log: VETO PAID amount=${step.amount} spent=${step.amount} of cap=1 remaining=1`,
      encodePaidLog({ mandate, amount: BigInt(step.amount), nonce: BigInt(step.nonce), spent: BigInt(step.amount) }),
      `Program ${PROGRAM.toBase58()} success`,
    ];
  }
  return [
    `Program ${PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${step.amount} per_tx_max=${PER_TX} remaining=1 override_to_clear=${step.amount}`,
    encodeRefusedLog({
      mandate,
      amount: BigInt(step.amount),
      nonce: BigInt(step.nonce),
      reason: 5,
      suggestedOverride: BigInt(step.amount),
    }),
    `Program ${PROGRAM.toBase58()} success`,
  ];
}

function chargeData(step: Charge): Buffer {
  return Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(step.amount)), u64Le(BigInt(step.nonce))]);
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, step: Charge): unknown {
  return {
    slot: step.slot,
    blockTime: step.timestamp,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
            data: chargeData(step),
          },
        ],
      },
    },
    meta: { err: null, logMessages: chargeLogs(mandate, step) },
  };
}

function chain(mandateId: bigint, steps: Step[]): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const txs = new Map<string, unknown>();
  for (const step of steps) {
    if (step.kind === "open") txs.set(step.signature, openTx(mandate, ledger, mandateId, step));
    else if (step.kind === "close") txs.set(step.signature, closeTx(mandate, ledger, step));
    else txs.set(step.signature, chargeTx(mandate, ledger, step));
  }
  const token = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(token, 32);
  const newestFirst = [...steps].reverse();
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(DEST)) {
        return { data: token, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
      }
      return null;
    },
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string; limit?: number }) {
      const start = config?.before ? newestFirst.findIndex((step) => step.signature === config.before) + 1 : 0;
      const limit = config?.limit ?? newestFirst.length;
      return newestFirst.slice(start, start + limit).map((step) => ({
        signature: step.signature,
        slot: step.slot,
        err: null,
        memo: null,
        blockTime: step.kind === "charge" ? step.timestamp : step.slot,
        confirmationStatus: "confirmed" as const,
      }));
    },
  } as unknown as Connection;
  return { conn, mandate };
}

async function capture<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  try {
    const value = await run();
    return { value, lines };
  } finally {
    console.error = orig;
  }
}

const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };

const charge1: Charge = {
  signature: "charge-1",
  slot: 2,
  amount: 100_000,
  nonce: 1,
  timestamp: 1_790_200_100,
  decision: "paid",
};
const charge2: Charge = {
  signature: "charge-2",
  slot: 5,
  amount: 50_000,
  nonce: 2,
  timestamp: 1_790_200_500,
  decision: "paid",
};

function closedOnce(): Step[] {
  return [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    { kind: "charge", ...charge1 },
    { kind: "close", signature: "close-1", slot: 3 },
  ];
}

function indexed(mandate: PublicKey, step: Charge): IndexedDecision {
  return {
    signature: step.signature,
    timestamp: step.timestamp,
    mandate: mandate.toBase58(),
    amount: BigInt(step.amount),
    nonce: BigInt(step.nonce),
    counterparty: DEST.toBase58(),
    kind: step.decision,
    reason: step.decision === "paid" ? 0 : 5,
    suggestedOverride: step.decision === "paid" ? 0n : BigInt(step.amount),
  };
}

test("export --signature writes a closed mandate from the opening tenure, notes that, and the record confirms", async () => {
  const { conn, mandate } = chain(204n, closedOnce());
  const { value: record, lines } = await capture(() =>
    recordFromSignature(conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS, {
      mandate: mandate.toBase58(),
      nonce: BigInt(charge1.nonce),
      amount: BigInt(charge1.amount),
    }),
  );
  assert.equal(record.limits.purpose, FIRST.purpose);
  assert.equal(record.limits.cap, FIRST.cap);
  assert.ok(lines.includes(`note: ${NOTE}`), lines.join("\n"));
  const written = parseRecord(JSON.parse(recordToJson(record)));
  const verdict = await assessRecord(written, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
  assert.match(verdict.text, /VERDICT: CONFIRMED/);
  assert.match(verdict.text, /first-tenure/);
  assert.match(verdict.text, /mandate account is closed and the limits came from the opening transaction/);
});

test("export --signature binds each closed tenure to the charge it covered", async () => {
  const { conn, mandate } = chain(2041n, [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    { kind: "charge", ...charge1 },
    { kind: "close", signature: "close-1", slot: 3 },
    { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
    { kind: "charge", ...charge2 },
    { kind: "close", signature: "close-2", slot: 6 },
  ]);
  const first = await recordFromSignature(conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS);
  const second = await recordFromSignature(conn, charge2.signature, PROGRAM, "devnet", DEVNET_GENESIS);
  const firstVerdict = await assessRecord(first, RPC, conn, OPTS);
  const secondVerdict = await assessRecord(second, RPC, conn, OPTS);
  assert.equal(firstVerdict.ok, true, firstVerdict.text);
  assert.match(firstVerdict.text, /first-tenure/);
  assert.equal(secondVerdict.ok, true, secondVerdict.text);
  assert.match(secondVerdict.text, /second-tenure/);
  assert.equal(first.mandate, mandate.toBase58());
  assert.equal(second.mandate, mandate.toBase58());
});

test("a tampered closed-mandate export is rejected", async () => {
  const { conn } = chain(2042n, closedOnce());
  const record = await recordFromSignature(conn, charge1.signature, PROGRAM, "devnet", DEVNET_GENESIS);
  const tampered: DecisionRecord = {
    ...record,
    limits: { ...record.limits, cap: record.limits.cap + 1n },
  };
  const verdict = await assessRecord(tampered, RPC, conn, OPTS);
  assert.equal(verdict.ok, false, verdict.text);
  assert.match(verdict.text, /limits\.cap/);
  assert.match(verdict.text, /VERDICT: REJECTED/);
  assert.doesNotMatch(verdict.text, /VERDICT: CONFIRMED/);
});

test("export --signature selects the paid charge in a closed multi-charge transaction", async () => {
  const refused: Charge = { ...charge1, decision: "refused", signature: "both" };
  const paid: Charge = { ...charge2, signature: "both", slot: 2, timestamp: charge1.timestamp };
  const { conn, mandate } = chain(2043n, [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    { kind: "close", signature: "close-1", slot: 3 },
  ]);
  const ledger = ledgerPda(PROGRAM, mandate);
  const both = {
    slot: 2,
    blockTime: paid.timestamp,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          { programIdIndex: 6, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7], data: chargeData(refused) },
          { programIdIndex: 6, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7], data: chargeData(paid) },
        ],
      },
    },
    meta: { err: null, logMessages: [...chargeLogs(mandate, refused), ...chargeLogs(mandate, paid)] },
  };
  const original = conn.getTransaction.bind(conn);
  conn.getTransaction = (async (signature: string) => {
    if (signature === "both") return both;
    return original(signature);
  }) as Connection["getTransaction"];
  const listed = conn.getSignaturesForAddress.bind(conn);
  conn.getSignaturesForAddress = (async (address: PublicKey, config?: { before?: string; limit?: number }) => {
    const pages = await listed(address, config);
    if (config?.before) return pages;
    return [
      { signature: "close-1", slot: 3, err: null, memo: null, blockTime: 3, confirmationStatus: "confirmed" as const },
      { signature: "both", slot: 2, err: null, memo: null, blockTime: paid.timestamp, confirmationStatus: "confirmed" as const },
      ...pages.filter((page) => page.signature === "open-1"),
    ];
  }) as Connection["getSignaturesForAddress"];
  const record = await recordFromSignature(conn, "both", PROGRAM, "devnet", DEVNET_GENESIS, {
    mandate: mandate.toBase58(),
    nonce: BigInt(paid.nonce),
    amount: BigInt(paid.amount),
  });
  assert.equal(record.kind, "paid");
  assert.equal(record.nonce, BigInt(paid.nonce));
  const verdict = await assessRecord(record, RPC, conn, OPTS);
  assert.equal(verdict.ok, true, verdict.text);
});

test("export --mandate writes each closed decision from the tenure that covered it", async () => {
  const steps: Step[] = [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    { kind: "charge", ...charge1 },
    { kind: "close", signature: "close-1", slot: 3 },
    { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
    { kind: "charge", ...charge2 },
    { kind: "close", signature: "close-2", slot: 6 },
  ];
  const { conn, mandate } = chain(2044n, steps);
  const { value: records, lines } = await capture(() =>
    recordsFromIndexedDecisions({
      conn,
      programId: PROGRAM,
      cluster: "devnet",
      genesisHash: DEVNET_GENESIS,
      decisions: [indexed(mandate, charge1), indexed(mandate, charge2)],
    }),
  );
  assert.equal(records.length, 2);
  assert.equal(lines.filter((line) => line === `note: ${NOTE}`).length, 2, lines.join("\n"));
  const first = await assessRecord(records[0]!, RPC, conn, OPTS);
  const second = await assessRecord(records[1]!, RPC, conn, OPTS);
  assert.equal(first.ok, true, first.text);
  assert.match(first.text, /first-tenure/);
  assert.equal(second.ok, true, second.text);
  assert.match(second.text, /second-tenure/);
});
