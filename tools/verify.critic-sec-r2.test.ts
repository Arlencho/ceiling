// Security critic, PR 121 round 2. Same mock chain shape as the round 1
// fixtures (verify.critic-sec-r1.test.ts).
//
//   1. RED on the head, pre-existing on main. The signer of a charge
//      transaction can plant a "VETO PAID amount=N" line ahead of the
//      program's own "VETO REFUSED" line with one SPL Memo instruction. The
//      ring row check filters by the record's kind (verify.ts checkRecord),
//      so a refused row never confronts a record that says paid, and the
//      logs fallback (lib.ts parseChargeLogs) takes the first matching line
//      in the whole transaction, whichever program wrote it. A refused charge
//      then confirms as paid. Two shapes: ring still holds the refused row,
//      and ring wrapped past it.
//   2. Control for the round 1 blockTime fix: a null blockTime with a single
//      row of that nonce still confirms the genuine record.
//   3. The bulk verdict context on the no-mandate date_range CONFIRMED path
//      and on the envelope REJECTED path, with a path-keyed two-URL RPC list.
//   4. Relabelling scope.type in either direction after deleting a paid row
//      rejects, so scope.type cannot pick the weaker population check.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog, encodeRefusedLog } from "../indexer/src/events.js";
import { makeBundle, type DecisionBundle } from "./bulk.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  parseRecord,
  reasonText,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const PATH_KEYED_LIST =
  "https://solana-devnet.g.alchemy.com/v2/SECRET123,https://cool-name.solana-devnet.quiknode.pro/SECRET123/";
const OPTS: AssessOpts = { env: {} };
const T0 = 1_789_937_883;

const LIMITS = {
  cap: 100_000_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "SE3 home charging",
};

type Row = {
  kind: "paid" | "refused";
  amount: number;
  nonce: number;
  timestamp: number;
  signature: string;
  blockTime?: number | null;
  // Log lines written by other programs in the same transaction, ahead of
  // the Veto program's own lines.
  memoLines?: string[];
};

function encodeMandate(mandateId: bigint, spendCount: number, refusalCount: number, spent: bigint): Buffer {
  const purpose = Buffer.from(LIMITS.purpose, "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, BigInt(LIMITS.cap), spent, BigInt(LIMITS.per_tx_max)]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeBigInt64LE(BigInt(LIMITS.expires_at), o);
  o += 8;
  for (const value of [0n, 0n, 0n]) {
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
  buf.writeUInt32LE(refusalCount, o);
  o += 4;
  buf[o] = 255;
  return buf;
}

function encodeLedger(mandate: PublicKey, rows: Row[]): Buffer {
  const data = Buffer.alloc(48 + LEDGER_CAPACITY * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(rows.length, 40);
  data.writeUInt16LE(rows.length % LEDGER_CAPACITY, 44);
  rows.forEach((row, seq) => {
    const off = 48 + (seq % LEDGER_CAPACITY) * 72;
    data.writeBigInt64LE(BigInt(row.timestamp), off);
    data.writeBigUInt64LE(BigInt(row.amount), off + 8);
    DEST.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(BigInt(row.nonce), off + 48);
    data.writeBigUInt64LE(BigInt(row.kind === "refused" ? row.amount : 0), off + 56);
    data[off + 64] = row.kind === "paid" ? KIND_PAID : KIND_REFUSED;
    data[off + 65] = row.kind === "paid" ? 0 : 5;
  });
  return data;
}

// Log shape of a real transaction: every program's lines sit between its own
// invoke and success lines. verify.ts does not read that structure.
function chargeTx(mandate: PublicKey, ledger: PublicKey, row: Row): unknown {
  const own =
    row.kind === "paid"
      ? [
          `Program log: VETO PAID amount=${row.amount} spent=${row.amount} of cap=${LIMITS.cap} remaining=1`,
          encodePaidLog({ mandate, amount: BigInt(row.amount), nonce: BigInt(row.nonce), spent: BigInt(row.amount) }),
        ]
      : [
          `Program log: VETO REFUSED reason=5 (${reasonText(5)}) amount=${row.amount} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${row.amount}`,
          encodeRefusedLog({
            mandate,
            amount: BigInt(row.amount),
            nonce: BigInt(row.nonce),
            reason: 5,
            suggestedOverride: BigInt(row.amount),
          }),
        ];
  const memo = row.memoLines
    ? [
        `Program ${MEMO_PROGRAM.toBase58()} invoke [1]`,
        ...row.memoLines,
        `Program ${MEMO_PROGRAM.toBase58()} success`,
      ]
    : [];
  const logs = [
    ...memo,
    `Program ${REAL_PROGRAM.toBase58()} invoke [1]`,
    "Program log: Instruction: Charge",
    ...own,
    `Program ${REAL_PROGRAM.toBase58()} success`,
  ];
  const keys = [AGENT, DEST, ledger, mandate, SOURCE, MINT, REAL_PROGRAM, TOKEN_PROGRAM_ID, MEMO_PROGRAM];
  const charge = {
    programIdIndex: 6,
    accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(BigInt(row.amount)), u64Le(BigInt(row.nonce))]),
  };
  const memoIx = { programIdIndex: 8, accountKeyIndexes: [], data: Buffer.from("VETO PAID amount=" + row.amount) };
  return {
    slot: 1,
    blockTime: row.blockTime === undefined ? row.timestamp : row.blockTime,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: row.memoLines ? [memoIx, charge] : [charge],
      },
    },
    meta: { err: null, logMessages: logs },
  };
}

function record(
  mandate: PublicKey,
  row: Row,
  claim: { kind?: "paid" | "refused"; timestamp?: number } = {},
): DecisionRecord {
  const kind = claim.kind ?? row.kind;
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: LIMITS,
    kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: claim.timestamp ?? row.timestamp,
    nonce: row.nonce,
    reason_code: kind === "paid" ? 0 : 5,
    reason_text: reasonText(kind === "paid" ? 0 : 5),
    suggested_override: kind === "refused" ? row.amount : 0,
    signature: row.signature,
  });
}

function tokenAccount(): Buffer {
  const data = Buffer.alloc(165);
  MERCHANT.toBuffer().copy(data, 32);
  return data;
}

function chain(mandateId: bigint, rows: Row[]): { conn: Connection; mandate: PublicKey; records: DecisionRecord[] } {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(REAL_PROGRAM, mandate);
  const paid = rows.filter((row) => row.kind === "paid");
  const refused = rows.filter((row) => row.kind === "refused");
  const spent = paid.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [DEST.toBase58(), { data: tokenAccount(), owner: TOKEN_PROGRAM_ID }],
    [mandate.toBase58(), { data: encodeMandate(mandateId, paid.length, refused.length, spent), owner: REAL_PROGRAM }],
    [ledger.toBase58(), { data: encodeLedger(mandate, rows), owner: REAL_PROGRAM }],
  ]);
  const txs = new Map<string, unknown>(rows.map((row) => [row.signature, chargeTx(mandate, ledger, row)]));
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
    async getAccountInfo(address: PublicKey) {
      const hit = accounts.get(address.toBase58());
      if (!hit) return null;
      return { data: hit.data, owner: hit.owner, executable: false, lamports: 1 };
    },
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string }) {
      if (config?.before) return [];
      return [...txs.entries()].map(([signature, tx]) => {
        const body = tx as { slot?: number; blockTime?: number | null };
        return {
          signature,
          slot: body.slot ?? 1,
          err: null,
          memo: null,
          blockTime: body.blockTime ?? null,
          confirmationStatus: "confirmed" as const,
        };
      });
    },
  } as unknown as Connection;
  return { conn, mandate, records: rows.map((row) => record(mandate, row)) };
}

function bundle(scope: DecisionBundle["scope"], decisions: DecisionRecord[]): DecisionBundle {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope,
    decisions,
  });
}

const THREE: Row[] = [
  { kind: "paid", amount: 446_000, nonce: 1, timestamp: T0, signature: "s-paid-1" },
  { kind: "refused", amount: 6_232_500, nonce: 2, timestamp: T0 + 9, signature: "s-refused-2" },
  { kind: "paid", amount: 214_500, nonce: 3, timestamp: T0 + 167, signature: "s-paid-3" },
];

// SPL Memo logs its payload with Debug formatting: Memo (len N): "text".
const MEMO_PAID = `Program log: Memo (len 23): "VETO PAID amount=600000"`;

test("critic sec r2: a refused charge with a planted VETO PAID memo line is not confirmed as paid (ring holds the row)", async () => {
  const rows: Row[] = [
    { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "memo-refused-5", memoLines: [MEMO_PAID] },
  ];
  const { conn, mandate } = chain(31n, rows);
  const genuine = await assessRecord(record(mandate, rows[0]!), RPC, conn, OPTS);
  const forged = await assessRecord(record(mandate, rows[0]!, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(
    forged.ok,
    false,
    `a refused charge confirms as paid on the strength of a memo line another program wrote:\n${forged.text}\n(genuine refused record: ${genuine.ok ? "CONFIRMED" : "REJECTED"})`,
  );
});

test("critic sec r2: the same forgery after the ring wrapped past the refusal is not confirmed", async () => {
  const rows: Row[] = [
    { kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "memo-wrapped-5", memoLines: [MEMO_PAID] },
  ];
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    rows.push({ kind: "refused", amount: 700_000, nonce: 10 + i, timestamp: T0 + 10 + i, signature: `filler-${i}` });
  }
  const { conn, mandate } = chain(32n, rows);
  const forged = await assessRecord(record(mandate, rows[0]!, { kind: "paid" }), RPC, conn, OPTS);
  assert.equal(forged.ok, false, `evicted refused charge confirms as paid from the memo line:\n${forged.text}`);
});

test("critic sec r2 control: blockTime null with one row of the nonce still confirms the genuine record", async () => {
  const rows: Row[] = [{ kind: "refused", amount: 600_000, nonce: 5, timestamp: T0, signature: "nb-only", blockTime: null }];
  const { conn, mandate } = chain(33n, rows);
  const result = await assessRecord(record(mandate, rows[0]!), RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
});

test("critic sec r2: bulk context on the no-mandate date_range confirmed and envelope-rejected paths, keyed list redacted", async () => {
  const { conn, mandate, records } = chain(34n, THREE);
  const scope = { type: "date_range" as const, mandate: null, from: T0 - 1, to: T0 + 200 };
  const confirmed = await assessBundle(bundle(scope, records), PATH_KEYED_LIST, conn, OPTS);
  assert.equal(confirmed.ok, true, confirmed.text);
  for (const token of ["scope               date_range", "mandate             none", `from                ${T0 - 1}`, `to                  ${T0 + 200}`, REAL_PROGRAM.toBase58(), "cluster             devnet"]) {
    assert.ok(confirmed.text.includes(token), `confirmed block lacks "${token}":\n${confirmed.text}`);
  }
  const foreign = record(mandate, { ...THREE[0]!, signature: "not-on-chain" });
  const rejected = await assessBundle(bundle(scope, [...records, foreign]), PATH_KEYED_LIST, conn, OPTS);
  assert.equal(rejected.ok, false, rejected.text);
  for (const token of ["VERDICT: REJECTED", "scope               date_range", `to                  ${T0 + 200}`, "not-on-chain"]) {
    assert.ok(rejected.text.includes(token), `rejected block lacks "${token}":\n${rejected.text}`);
  }
  const leaked = [confirmed.text, rejected.text].filter((text) => text.includes("SECRET123"));
  assert.deepEqual(leaked, [], leaked.join("\n---\n"));
});

test("critic sec r2: relabelling scope.type in either direction after deleting a paid row rejects", async () => {
  const { conn, mandate, records } = chain(35n, THREE);
  const pruned = records.filter((row) => row.signature !== "s-paid-3");
  const asRange = await assessBundle(
    bundle({ type: "date_range", mandate: mandate.toBase58(), from: T0 - 1, to: T0 + 200 }, pruned),
    RPC,
    conn,
    OPTS,
  );
  assert.equal(asRange.ok, false, asRange.text);
  assert.match(asRange.text, /s-paid-3 is in the indexed date_range and missing from the file/);
  const asRule = await assessBundle(bundle({ type: "rule", mandate: mandate.toBase58(), from: null, to: null }, pruned), RPC, conn, OPTS);
  assert.equal(asRule.ok, false, asRule.text);
  assert.match(asRule.text, /paid rows: file has 1, mandate spend_count is 2/);
});
