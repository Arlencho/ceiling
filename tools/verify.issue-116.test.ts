// Issue 116. After close_mandate the account is gone. Limits come from the
// open_mandate whose tenure contains the decision. A second tenure at the
// same PDA must not supply them. Ambiguous history and a null body fail closed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import { isTransportError } from "../indexer/src/rpc.js";
import {
  CHARGE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  parseRecord,
  reasonText,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessRecord, type AssessOpts } from "./verify.js";

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

type Step =
  | { kind: "open"; signature: string; slot: number; limits: Limits }
  | { kind: "close"; signature: string; slot: number }
  | { kind: "charge"; signature: string; slot: number; amount: number; nonce: number; timestamp: number };

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
        compiledInstructions: [
          { programIdIndex: 3, accountKeyIndexes: [0, 1, 2], data: disc("close_mandate") },
        ],
      },
    },
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, "Program log: VETO CLOSED", `Program ${PROGRAM.toBase58()} success`] },
  };
}

function chargeTx(mandate: PublicKey, ledger: PublicKey, step: Extract<Step, { kind: "charge" }>): unknown {
  const logs = [
    `Program ${PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    `Program log: VETO PAID amount=${step.amount} spent=${step.amount} of cap=1 remaining=1`,
    encodePaidLog({ mandate, amount: BigInt(step.amount), nonce: BigInt(step.nonce), spent: BigInt(step.amount) }),
    `Program ${PROGRAM.toBase58()} success`,
  ];
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
            data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(step.amount)), u64Le(BigInt(step.nonce))]),
          },
        ],
      },
    },
    meta: { err: null, logMessages: logs },
  };
}

function recordFor(mandate: PublicKey, step: Extract<Step, { kind: "charge" }>, limits: Limits): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: {
      cap: Number(limits.cap),
      per_tx_max: Number(PER_TX),
      expires_at: Number(EXPIRES),
      merchant: MERCHANT.toBase58(),
      purpose: limits.purpose,
    },
    kind: "paid",
    amount: step.amount,
    counterparty: DEST.toBase58(),
    timestamp: step.timestamp,
    nonce: step.nonce,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: step.signature,
  });
}

function chain(mandateId: bigint, steps: Step[], nullSigs: ReadonlySet<string> = new Set()): { conn: Connection; mandate: PublicKey } {
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
      if (nullSigs.has(signature)) return null;
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

const FIRST: Limits = { cap: 1_000_000n, purpose: "first-tenure" };
const SECOND: Limits = { cap: 2_000_000n, purpose: "second-tenure" };

const charge1: Extract<Step, { kind: "charge" }> = {
  kind: "charge",
  signature: "charge-1",
  slot: 2,
  amount: 100_000,
  nonce: 1,
  timestamp: 1_790_200_100,
};
const charge2: Extract<Step, { kind: "charge" }> = {
  kind: "charge",
  signature: "charge-2",
  slot: 5,
  amount: 50_000,
  nonce: 2,
  timestamp: 1_790_200_500,
};

function reopened(): Step[] {
  return [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    charge1,
    { kind: "close", signature: "close-1", slot: 3 },
    { kind: "open", signature: "open-2", slot: 4, limits: SECOND },
    charge2,
    { kind: "close", signature: "close-2", slot: 6 },
  ];
}

test("a closed mandate confirms from the opening transaction and says so", async () => {
  const { conn, mandate } = chain(116n, [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    charge1,
    { kind: "close", signature: "close-1", slot: 3 },
  ]);
  const result = await assessRecord(recordFor(mandate, charge1, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, new RegExp(NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a reopened PDA binds the tenure that contains the decision", async () => {
  const { conn, mandate } = chain(1161n, reopened());
  const first = await assessRecord(recordFor(mandate, charge1, FIRST), RPC, conn, OPTS);
  assert.equal(first.ok, true, first.text);
  assert.match(first.text, /first-tenure/);
  const wrongTenure = await assessRecord(recordFor(mandate, charge1, SECOND), RPC, conn, OPTS);
  assert.equal(wrongTenure.ok, false, wrongTenure.text);
  assert.match(wrongTenure.text, /limits\.purpose/);
  assert.doesNotMatch(wrongTenure.text, /VERDICT: CONFIRMED/);
  const second = await assessRecord(recordFor(mandate, charge2, SECOND), RPC, conn, OPTS);
  assert.equal(second.ok, true, second.text);
  assert.match(second.text, /second-tenure/);
});

test("two opens without a close make the limits ambiguous and the record does not confirm", async () => {
  const { conn, mandate } = chain(1162n, [
    { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
    { kind: "open", signature: "open-2", slot: 2, limits: SECOND },
    charge1,
  ]);
  const result = await assessRecord(recordFor(mandate, charge1, FIRST), RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.match(result.text, /ambiguous/);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
});

test("a null body for the opening transaction is not checked", async () => {
  const { conn, mandate } = chain(
    1163n,
    [
      { kind: "open", signature: "open-1", slot: 1, limits: FIRST },
      charge1,
      { kind: "close", signature: "close-1", slot: 3 },
    ],
    new Set(["open-1"]),
  );
  await assert.rejects(
    () => assessRecord(recordFor(mandate, charge1, FIRST), RPC, conn, OPTS),
    (err: unknown) => {
      assert.equal(isTransportError(err), true);
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /open-1/);
      return true;
    },
  );
});
