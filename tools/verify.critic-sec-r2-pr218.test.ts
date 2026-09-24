// Security round 2, PR 218 (issue 216). The round 1 fix decides that a
// lookup table is unresolved when a programIdIndex is at or past the
// resolved key list. A loaded set missing an entry from the front shifts
// every later key one slot, so the CPI index resolves to the wrong program
// and the hidden relay reads as absent; a short set beside an empty CPI
// list does the same. This file runs the no-mandate date_range check
// through assessBundle with a two-entry table on the listed path and the
// block-scan path. A missing log body must print not checked; a present
// Paid frame must reject the file that omits it; neither may print
// VERDICT: CONFIRMED.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "../indexer/src/events.js";
import { makeBundle } from "./bulk.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  parseRecord,
  reasonText,
  u64Le,
} from "./lib.js";
import { assessBundle, type AssessOpts } from "./verify.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const P = PROGRAM.toBase58();
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const OUTER = new PublicKey("ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const T1 = 1_790_200_100;
const CAP = 1_000_000n;
const PER_TX = 500_000n;
const EXPIRES = 1_797_713_870n;
const HIDDEN = "hidden-r2";

function encodeMandate(mandateId: bigint, spendCount: number): Buffer {
  const purpose = Buffer.from("probe", "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, CAP, 100_000n, PER_TX]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeBigInt64LE(EXPIRES, o);
  o += 8;
  for (const value of [0n, 0n, 2n]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeUInt32LE(purpose.length, o);
  o += 4;
  purpose.copy(buf, o);
  o += purpose.length;
  buf[o] = 0;
  o += 1;
  buf.writeUInt32LE(spendCount, o);
  o += 4;
  buf.writeUInt32LE(0, o);
  o += 4;
  buf[o] = 255;
  return buf;
}

type Row = { amount: number; nonce: number; timestamp: number };

function encodeLedger(mandate: PublicKey, rows: Row[]): Buffer {
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(rows.length, 40);
  data.writeUInt16LE(rows.length % LEDGER_CAPACITY, 44);
  rows.forEach((row, seq) => {
    const off = 48 + seq * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(row.amount), off + 8);
    DEST.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data[off + 64] = KIND_PAID;
  });
  return data;
}

const keys = (mandate: PublicKey, ledger: PublicKey) => [
  AGENT,
  DEST,
  ledger,
  mandate,
  SOURCE,
  MINT,
  PROGRAM,
  TOKEN_PROGRAM_ID,
  OUTER,
];

function chargeIx(amount: number, nonce: number) {
  return {
    programIdIndex: 6,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(amount)), u64Le(BigInt(nonce))]),
  };
}

function topLevelPaid(mandate: PublicKey, ledger: PublicKey, row: Row, slot: number) {
  return {
    slot,
    blockTime: row.timestamp,
    transaction: {
      message: { staticAccountKeys: keys(mandate, ledger), compiledInstructions: [chargeIx(row.amount, row.nonce)] },
    },
    meta: {
      err: null,
      logMessages: [
        `Program ${P} invoke [1]`,
        "Program log: Instruction: Charge",
        `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=1 remaining=1`,
        encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
        `Program ${P} success`,
      ],
    },
  };
}

const TABLE = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");

// The relay's message: top level invokes OUTER, the program sits in the
// static keys. What the meta says about the log body and the CPI list is
// the shape under test.
function relayMessage(mandate: PublicKey, ledger: PublicKey) {
  return {
    staticAccountKeys: keys(mandate, ledger),
    compiledInstructions: [{ programIdIndex: 8, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7, 6], data: Buffer.from([1]) }],
  };
}

function relayPaid(mandate: PublicKey, ledger: PublicKey, row: Row, slot: number, meta: unknown) {
  return { slot, blockTime: row.timestamp, transaction: { message: relayMessage(mandate, ledger) }, meta };
}

// The program is not in the static keys; it comes in through an address
// lookup table. `meta` is what the node said beside that table.
function relayLookup(mandate: PublicKey, ledger: PublicKey, row: Row, slot: number, meta: Record<string, unknown>) {
  const staticKeys = keys(mandate, ledger).filter((key) => !key.equals(PROGRAM));
  return {
    slot,
    blockTime: row.timestamp,
    transaction: {
      message: {
        staticAccountKeys: staticKeys,
        compiledInstructions: [{ programIdIndex: 7, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 6], data: Buffer.from([1]) }],
        addressTableLookups: [{ accountKey: TABLE, writableIndexes: [], readonlyIndexes: [0, 1] }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 8, accounts: [0, 3, 2, 4, 1, 5, 6], data: "" }] }],
      ...meta,
    },
  };
}

function relayLogs(mandate: PublicKey, row: Row): string[] {
  return [
    `Program ${OUTER.toBase58()} invoke [1]`,
    `Program ${P} invoke [2]`,
    "Program log: Instruction: Charge",
    encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
    `Program ${P} success`,
    `Program ${OUTER.toBase58()} success`,
  ];
}

function page<T extends { signature: string }>(rows: T[], config?: { before?: string; limit?: number }): T[] {
  const start = config?.before ? rows.findIndex((item) => item.signature === config.before) + 1 : 0;
  return rows.slice(start, start + (config?.limit ?? rows.length));
}

const OTHER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
// The table declares two readonly entries: the program, then OTHER.
const SHIFTED = { writable: [], readonly: [OTHER] };
const EMPTY = { writable: [], readonly: [] };
const FULL = { writable: [], readonly: [PROGRAM, OTHER] };

type Meta = (mandate: PublicKey, row: Row) => Record<string, unknown>;
type Expect = "unchecked" | "rejected";

const shapes: { name: string; meta: Meta; expect: Expect }[] = [
  { name: "a shifted short loadedAddresses and a null log body", meta: () => ({ loadedAddresses: SHIFTED, logMessages: null }), expect: "unchecked" },
  { name: "a shifted short loadedAddresses and no logMessages key", meta: () => ({ loadedAddresses: SHIFTED }), expect: "unchecked" },
  { name: "a shifted short loadedAddresses, an empty CPI list and a null log body", meta: () => ({ loadedAddresses: SHIFTED, innerInstructions: [], logMessages: null }), expect: "unchecked" },
  { name: "an empty loadedAddresses, an empty CPI list and a null log body", meta: () => ({ loadedAddresses: EMPTY, innerInstructions: [], logMessages: null }), expect: "unchecked" },
  { name: "a shifted short loadedAddresses and the Paid frame", meta: (m, r) => ({ loadedAddresses: SHIFTED, logMessages: relayLogs(m, r) }), expect: "rejected" },
  { name: "a full loadedAddresses and a null log body", meta: () => ({ loadedAddresses: FULL, logMessages: null }), expect: "unchecked" },
  { name: "a full loadedAddresses and the Paid frame", meta: (m, r) => ({ loadedAddresses: FULL, logMessages: relayLogs(m, r) }), expect: "rejected" },
];

for (const path of ["listed", "block scan"] as const) {
  for (const shape of shapes) {
    test(`${path}: a no-mandate date_range that omits a lookup-table CPI payment with ${shape.name} is ${shape.expect}`, async () => {
      const mandateId = 1599n;
      const mandate = mandatePda(PROGRAM, OWNER, mandateId);
      const ledger = ledgerPda(PROGRAM, mandate);
      const shown: Row = { amount: 100_000, nonce: 1, timestamp: T1 };
      const hidden: Row = { amount: 100_000, nonce: 2, timestamp: T1 + 1 };
      const shownTx = topLevelPaid(mandate, ledger, shown, 2);
      const hiddenTx = relayLookup(mandate, ledger, hidden, 3, shape.meta(mandate, hidden));
      const txs = new Map<string, unknown>([
        ["shown-1", shownTx],
        [HIDDEN, hiddenTx],
      ]);
      const programListed =
        path === "listed"
          ? [
              { signature: HIDDEN, slot: 3, err: null, memo: null, blockTime: T1 + 1, confirmationStatus: "confirmed" as const },
              { signature: "shown-1", slot: 2, err: null, memo: null, blockTime: T1, confirmationStatus: "confirmed" as const },
            ]
          : [];
      const mandateListed = [
        { signature: "shown-1", slot: 2, err: null, memo: null, blockTime: T1, confirmationStatus: "confirmed" as const },
      ];
      const token = Buffer.alloc(165);
      MERCHANT.toBuffer().copy(token, 32);
      const accounts = new Map<string, Buffer>([
        [mandate.toBase58(), encodeMandate(mandateId, 2)],
        [ledger.toBase58(), encodeLedger(mandate, [shown, hidden])],
      ]);
      const conn = {
        async getGenesisHash() {
          return DEVNET_GENESIS;
        },
        async getTransaction(signature: string) {
          return txs.get(signature) ?? null;
        },
        async getAccountInfo(address: PublicKey) {
          if (address.equals(DEST)) return { data: token, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
          const data = accounts.get(address.toBase58());
          return data ? { data, owner: PROGRAM, executable: false, lamports: 1 } : null;
        },
        async getSignaturesForAddress(address: PublicKey, config?: { before?: string; limit?: number }) {
          if (address.equals(PROGRAM)) return page(programListed, config);
          if (address.equals(mandate)) return page(mandateListed, config);
          return [];
        },
        async getSlot() {
          return 5;
        },
        async getFirstAvailableBlock() {
          return 5;
        },
        async getBlocks() {
          return [5];
        },
        async getBlock() {
          return {
            blockTime: T1 + 1,
            transactions: [
              { transaction: { signatures: ["shown-1"], message: (shownTx as { transaction: { message: unknown } }).transaction.message }, meta: (shownTx as { meta: unknown }).meta },
              { transaction: { signatures: [HIDDEN], message: hiddenTx.transaction.message }, meta: hiddenTx.meta },
            ],
          };
        },
      } as unknown as Connection;
      const bundle = makeBundle({
        cluster: "devnet",
        genesisHash: DEVNET_GENESIS,
        programId: P,
        scope: { type: "date_range", mandate: null, from: T1 - 10, to: T1 + 10 },
        decisions: [
          parseRecord({
            schema_version: 1,
            cluster: "devnet",
            genesis_hash: DEVNET_GENESIS,
            program_id: P,
            mandate: mandate.toBase58(),
            limits: {
              cap: Number(CAP),
              per_tx_max: Number(PER_TX),
              expires_at: Number(EXPIRES),
              merchant: MERCHANT.toBase58(),
              purpose: "probe",
            },
            kind: "paid",
            amount: shown.amount,
            counterparty: DEST.toBase58(),
            timestamp: shown.timestamp,
            nonce: shown.nonce,
            reason_code: 0,
            reason_text: reasonText(0),
            suggested_override: 0,
            signature: "shown-1",
          }),
        ],
      });
      const result = await assessBundle(bundle, RPC, conn, { ...OPTS, allowBlockScan: path === "block scan" });
      assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/, result.text);
      assert.equal(result.ok, false, result.text);
      assert.match(result.text, new RegExp(HIDDEN), result.text);
      if (shape.expect === "unchecked") {
        assert.equal(result.code, 3, result.text);
        assert.match(result.text, /not checked/, result.text);
        assert.doesNotMatch(result.text, /VERDICT: REJECTED/, result.text);
      } else {
        assert.equal(result.code, 1, result.text);
        assert.match(result.text, /VERDICT: REJECTED/, result.text);
        assert.match(result.text, new RegExp(`${HIDDEN} is in the indexed date_range and missing from the file`), result.text);
      }
    });
  }
}
