// Issues 113, 114, 115, 117, and the verify print named in 120.
// Inputs are the ones the verification comment on issue 110 ran:
// program ids 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV and
// 4uTEG51hvzg2UpBKwPGkhbgutxNjBkmfZwRS2QGLVBs2, mandate
// CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g, paid row 4N13AokS amount
// 446000, signature 3rTpyrHE..., genesis 5NrLCg7..., cluster mainnet-beta,
// scope mandate 7Bns2E..., and the two same-nonce refusals at 1790106172
// (2VQjAk5J) and 1790106175 (38rQnNMH).
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { buildScope, makeBundle, type DecisionBundle } from "./bulk.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  decodeMandate,
  ledgerPda,
  mandatePda,
  parseRecord,
  reasonText,
  u64Le,
  type DecisionRecord,
} from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const CLONE_PROGRAM = "4uTEG51hvzg2UpBKwPGkhbgutxNjBkmfZwRS2QGLVBs2";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OTHER_GENESIS = "5NrLCg7BRzhkDYxbiDy966tfYmVPfpprZamwXLALe3L5";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MANDATE = "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g";
const OTHER_MANDATE = "7Bns2EMrzw9T8apGLRGynean4mkFMwHsEWoXbeTGnNtj";
const PAID_446000 = "4N13AokSVj2A9fJyCZiypzhG9P6mdpMvpjcnDvzVUi2Qp6jUx1Ud34tHUDt1TQENzXu7TFWTfrKHHCLfrpKTBJ9a";
const SINGLE_SIG = "3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const DEVNET_RPC = "https://api.devnet.solana.com";
const KEYED_RPC = "https://rpc.example.test/?api-key=SECRET123";
const OPTS: AssessOpts = { env: {} };

const LIMITS = {
  cap: 100_000_000,
  per_tx_max: 500_000,
  expires_at: 1_797_713_870,
  merchant: MERCHANT.toBase58(),
  purpose: "SE3 home charging",
};

type ChargeRow = {
  kind: "paid" | "refused";
  amount: number;
  nonce: number;
  timestamp: number;
  reason: number;
  override: number;
  signature: string;
};

// Paid and refused rows on CZw2prUt..., in ledger order, with the signatures
// getSignaturesForAddress returned for those block times.
const DEVNET_ROWS: ChargeRow[] = [
  { kind: "paid", amount: 446000, nonce: 1789855200, timestamp: 1789937883, reason: 0, override: 0, signature: PAID_446000 },
  { kind: "paid", amount: 214500, nonce: 1789876800, timestamp: 1789937883, reason: 0, override: 0, signature: "5heSaH7LCYKAUXcPo9M2167oxLPvJSuTDmtyRboPv4pbif2ndNqgNJ9DagWeT2T2XKa5BU9erjfw7wjS6wyxM7xb" },
  { kind: "refused", amount: 6232500, nonce: 1789920000, timestamp: 1789937892, reason: 5, override: 6232500, signature: SINGLE_SIG },
  { kind: "paid", amount: 5500, nonce: 1789898400, timestamp: 1789938050, reason: 0, override: 0, signature: "289RQXJW2vkvXxiVM13vwSEWb1SuRAxPKTHCgkF5kqPYWPQ2hFGsq13PUrDTMZ8ibApq9BBJz2u2zpzjkRV92swU" },
  { kind: "refused", amount: 8163000, nonce: 1789941600, timestamp: 1789941600, reason: 5, override: 8163000, signature: "5MJLtM92foysaWgfqs6x6oBYxyES2Ra2st8UK47dRX8h1F2wo43qQxJt4GFycEWiLSKJQjWbUBhotHMhkHymLoBU" },
  { kind: "refused", amount: 21542500, nonce: 1789963200, timestamp: 1789963208, reason: 5, override: 21542500, signature: "47PZmcRp85U5s3S9GjKekJ7BYcfLeCvY3MKhcDyhyn8Rt5YRdLL5MviymKfFKBeiswn3owx8P6VianW4MRLfU97N" },
  { kind: "refused", amount: 7903500, nonce: 1789984800, timestamp: 1789984800, reason: 5, override: 7903500, signature: "5HTd7nhtGvz2zpxxbszgVBhRAjcv52MTBRLvVoxRt98LXJvaVsEDRcLSbsAzx1SMdRoxekzhTBtmx6T6xTfDVMdr" },
  { kind: "refused", amount: 63938500, nonce: 1790006400, timestamp: 1790006409, reason: 5, override: 63938500, signature: "59ePBRRBGdu51J7aURacABWNtzqhvpWLFzsSfEcFA5eJd4Zn2y2gtY9MtG6fF6dgG8CdFKbWDzvnKGJRSmZKngyq" },
  { kind: "refused", amount: 64852000, nonce: 1790028000, timestamp: 1790028011, reason: 5, override: 64852000, signature: "SNZdXV6H5JCuPKxDB5K7ykMbADByXew2nNRuPiue6ETmSRUP9NZgqMuh3XgoEFDZnv7Ltx15JdBAwV7rrf8Umy8" },
];

type LedgerSlot = {
  kind: number;
  amount: bigint;
  nonce: bigint;
  ts: bigint;
  reason: number;
  suggestedOverride: bigint;
  counterparty: PublicKey;
};

function encodeMandate(args: {
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  merchant: PublicKey;
  mandateId: bigint;
  cap: bigint;
  spent: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  lastNonce: bigint;
  purpose: string;
  spendCount: number;
  refusalCount: number;
  bump: number;
}): Buffer {
  const purpose = Buffer.from(args.purpose, "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [args.owner, args.agent, args.mint, args.source, args.merchant]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [args.mandateId, args.cap, args.spent, args.perTxMax]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeBigInt64LE(args.expiresAt, o);
  o += 8;
  for (const value of [0n, 0n, args.lastNonce]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeUInt32LE(purpose.length, o);
  o += 4;
  purpose.copy(buf, o);
  o += purpose.length;
  buf[o] = 0;
  o += 1;
  buf.writeUInt32LE(args.spendCount, o);
  o += 4;
  buf.writeUInt32LE(args.refusalCount, o);
  o += 4;
  buf[o] = args.bump;
  return buf;
}

function encodeLedger(mandate: PublicKey, slots: LedgerSlot[]): Buffer {
  const data = Buffer.alloc(48 + 32 * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  mandate.toBuffer().copy(data, 8);
  data.writeUInt32LE(slots.length, 40);
  data.writeUInt16LE(slots.length, 44);
  slots.forEach((slot, i) => {
    const off = 48 + i * 72;
    data.writeBigInt64LE(slot.ts, off);
    data.writeBigUInt64LE(slot.amount, off + 8);
    slot.counterparty.toBuffer().copy(data, off + 16);
    data.writeBigUInt64LE(slot.nonce, off + 48);
    data.writeBigUInt64LE(slot.suggestedOverride, off + 56);
    data[off + 64] = slot.kind;
    data[off + 65] = slot.reason;
  });
  return data;
}

function tokenAccount(owner: PublicKey): Buffer {
  const data = Buffer.alloc(165);
  owner.toBuffer().copy(data, 32);
  return data;
}

function chargeTx(args: {
  programId: PublicKey;
  agent: PublicKey;
  mandate: PublicKey;
  ledger: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  mint: PublicKey;
  amount: bigint;
  nonce: bigint;
  blockTime: number;
  logs: string[];
}): unknown {
  return {
    slot: 1,
    blockTime: args.blockTime,
    transaction: {
      message: {
        staticAccountKeys: [
          args.agent,
          args.destination,
          args.ledger,
          args.mandate,
          args.source,
          args.mint,
          args.programId,
          TOKEN_PROGRAM_ID,
        ],
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
            data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(args.amount), u64Le(args.nonce)]),
          },
        ],
      },
    },
    meta: { err: null, logMessages: args.logs },
  };
}

function logsFor(row: ChargeRow): string[] {
  if (row.kind === "paid") return [`Program log: VETO PAID amount=${row.amount}`];
  return [
    `Program log: VETO REFUSED reason=${row.reason} (${reasonText(row.reason)}) amount=${row.amount} per_tx_max=${LIMITS.per_tx_max} remaining=1 override_to_clear=${row.override}`,
  ];
}

function decisionFor(row: ChargeRow, programId: string, mandate: string): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: programId,
    mandate,
    limits: LIMITS,
    kind: row.kind,
    amount: row.amount,
    counterparty: DEST.toBase58(),
    timestamp: row.timestamp,
    nonce: row.nonce,
    reason_code: row.reason,
    reason_text: reasonText(row.reason),
    suggested_override: row.override,
    signature: row.signature,
  });
}

type World = {
  conn: Connection;
  records: DecisionRecord[];
  bundle: DecisionBundle;
};

function world(args: {
  programId: PublicKey;
  owner: PublicKey;
  mandateId: bigint;
  rows: ChargeRow[];
  spendCount: number;
  refusalCount: number;
  spent: bigint;
  lastNonce: bigint;
  open: boolean;
  bump: number;
}): World {
  const mandate = mandatePda(args.programId, args.owner, args.mandateId);
  const ledger = ledgerPda(args.programId, mandate);
  const slots: LedgerSlot[] = [];
  if (args.open) {
    slots.push({
      kind: 0,
      amount: BigInt(LIMITS.cap),
      nonce: 0n,
      ts: 1789937870n,
      reason: 0,
      suggestedOverride: 0n,
      counterparty: MERCHANT,
    });
  }
  for (const row of args.rows) {
    slots.push({
      kind: row.kind === "paid" ? KIND_PAID : KIND_REFUSED,
      amount: BigInt(row.amount),
      nonce: BigInt(row.nonce),
      ts: BigInt(row.timestamp),
      reason: row.reason,
      suggestedOverride: BigInt(row.override),
      counterparty: DEST,
    });
  }
  const mandateBytes = encodeMandate({
    owner: args.owner,
    agent: AGENT,
    mint: MINT,
    source: SOURCE,
    merchant: MERCHANT,
    mandateId: args.mandateId,
    cap: BigInt(LIMITS.cap),
    spent: args.spent,
    perTxMax: BigInt(LIMITS.per_tx_max),
    expiresAt: BigInt(LIMITS.expires_at),
    lastNonce: args.lastNonce,
    purpose: LIMITS.purpose,
    spendCount: args.spendCount,
    refusalCount: args.refusalCount,
    bump: args.bump,
  });
  decodeMandate(mandateBytes);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>([
    [mandate.toBase58(), { data: mandateBytes, owner: args.programId }],
    [ledger.toBase58(), { data: encodeLedger(mandate, slots), owner: args.programId }],
    [DEST.toBase58(), { data: tokenAccount(MERCHANT), owner: TOKEN_PROGRAM_ID }],
  ]);
  const txs = new Map<string, unknown>();
  for (const row of args.rows) {
    txs.set(
      row.signature,
      chargeTx({
        programId: args.programId,
        agent: AGENT,
        mandate,
        ledger,
        source: SOURCE,
        destination: DEST,
        mint: MINT,
        amount: BigInt(row.amount),
        nonce: BigInt(row.nonce),
        blockTime: row.timestamp,
        logs: logsFor(row),
      }),
    );
  }
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
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string; limit?: number }) {
      const listed = [...txs.keys()];
      const start = config?.before ? listed.indexOf(config.before) + 1 : 0;
      const limit = config?.limit ?? listed.length;
      return listed.slice(start, start + limit).map((signature) => {
        const body = txs.get(signature) as { slot?: number; blockTime?: number | null; meta?: { err?: unknown } };
        return {
          signature,
          slot: typeof body?.slot === "number" ? body.slot : 1,
          err: body?.meta?.err ?? null,
          memo: null,
          blockTime: body?.blockTime ?? null,
          confirmationStatus: "confirmed" as const,
        };
      });
    },
  } as unknown as Connection;
  const records = args.rows.map((row) => decisionFor(row, args.programId.toBase58(), mandate.toBase58()));
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: args.programId.toBase58(),
    scope: buildScope({ mandate: mandate.toBase58() }),
    decisions: records,
  });
  return { conn, records, bundle };
}

function devnetWorld(): World {
  return world({
    programId: new PublicKey(REAL_PROGRAM),
    owner: OWNER,
    mandateId: 1n,
    rows: DEVNET_ROWS,
    spendCount: 3,
    refusalCount: 6,
    spent: 666000n,
    lastNonce: 1789898400n,
    open: true,
    bump: 255,
  });
}

test("issue 113: a record from a program id the tool is not built for is rejected", async () => {
  const devnet = devnetWorld();
  assert.equal(devnet.bundle.scope.mandate, MANDATE);
  const genuine = devnet.records.find((row) => row.signature === SINGLE_SIG);
  assert.ok(genuine);
  const held = await assessRecord(genuine, DEVNET_RPC, devnet.conn, OPTS);
  assert.equal(held.ok, true, held.text);

  const cloneProgram = new PublicKey(CLONE_PROGRAM);
  const cloned = world({
    programId: cloneProgram,
    owner: OWNER,
    mandateId: 1n,
    rows: [
      {
        kind: "paid",
        amount: 100000,
        nonce: 1,
        timestamp: 1790106172,
        reason: 0,
        override: 0,
        signature: "clone-paid-100000",
      },
    ],
    spendCount: 1,
    refusalCount: 0,
    spent: 100000n,
    lastNonce: 1n,
    open: false,
    bump: 254,
  });
  const result = await assessRecord(cloned.records[0]!, DEVNET_RPC, cloned.conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, new RegExp(CLONE_PROGRAM));
  assert.match(result.text, new RegExp(REAL_PROGRAM));
});

test("issue 114: a pruned, emptied, duplicated, or relabelled rule export is rejected", async () => {
  const { conn, bundle, records } = devnetWorld();
  const paid = records.find((row) => row.signature === PAID_446000);
  assert.ok(paid);
  assert.equal(paid.amount, 446000n);
  const control = await assessBundle(bundle, DEVNET_RPC, conn, OPTS);
  assert.equal(control.ok, true, control.text);

  const withoutPaid = makeBundle({
    cluster: bundle.cluster,
    genesisHash: bundle.genesis_hash,
    programId: bundle.program_id,
    scope: bundle.scope,
    decisions: records.filter((row) => row.signature !== PAID_446000),
  });
  const emptied = makeBundle({
    cluster: bundle.cluster,
    genesisHash: bundle.genesis_hash,
    programId: bundle.program_id,
    scope: bundle.scope,
    decisions: [],
  });
  const duplicated = makeBundle({
    cluster: bundle.cluster,
    genesisHash: bundle.genesis_hash,
    programId: bundle.program_id,
    scope: bundle.scope,
    decisions: [...records, paid],
  });
  const cases: Array<{ name: string; bundle: DecisionBundle; needle: RegExp }> = [
    { name: "one paid row deleted (4N13AokS amount 446000)", bundle: withoutPaid, needle: /446000/ },
    { name: "decisions emptied", bundle: emptied, needle: /spend_count|ledger/ },
    { name: "one row duplicated", bundle: duplicated, needle: new RegExp(PAID_446000) },
    {
      name: "scope.mandate relabelled",
      bundle: { ...bundle, scope: { ...bundle.scope, mandate: OTHER_MANDATE } },
      needle: new RegExp(OTHER_MANDATE),
    },
    {
      name: "envelope cluster mainnet-beta",
      bundle: { ...bundle, cluster: "mainnet-beta" },
      needle: /mainnet-beta/,
    },
    {
      name: "envelope genesis_hash other",
      bundle: { ...bundle, genesis_hash: OTHER_GENESIS },
      needle: new RegExp(OTHER_GENESIS),
    },
    {
      name: "envelope program_id token program",
      bundle: { ...bundle, program_id: TOKEN_PROGRAM },
      needle: new RegExp(TOKEN_PROGRAM),
    },
  ];
  const confirmed: string[] = [];
  for (const item of cases) {
    const result = await assessBundle(item.bundle, DEVNET_RPC, conn, OPTS);
    if (result.ok || !result.text.includes("VERDICT: REJECTED") || !item.needle.test(result.text)) {
      confirmed.push(`${item.name}\n${result.text}`);
    }
  }
  assert.deepEqual(confirmed, [], confirmed.join("\n---\n"));
});

test("issue 115: two refusals of one nonce bind to the signature, not the newest row", async () => {
  const owner = Keypair.generate().publicKey;
  const firstSig = "2VQjAk5J";
  const secondSig = "38rQnNMH";
  const built = world({
    programId: new PublicKey(REAL_PROGRAM),
    owner,
    mandateId: 5n,
    rows: [
      {
        kind: "refused",
        amount: 600000,
        nonce: 5,
        timestamp: 1790106172,
        reason: 5,
        override: 600000,
        signature: firstSig,
      },
      {
        kind: "refused",
        amount: 600000,
        nonce: 5,
        timestamp: 1790106175,
        reason: 5,
        override: 600000,
        signature: secondSig,
      },
    ],
    spendCount: 0,
    refusalCount: 2,
    spent: 0n,
    lastNonce: 0n,
    open: false,
    bump: 1,
  });
  const first = built.records[0]!;
  const second = built.records[1]!;
  const forged = parseRecord({
    ...JSON.parse(JSON.stringify({
      schema_version: 1,
      cluster: first.cluster,
      genesis_hash: first.genesis_hash,
      program_id: first.program_id,
      mandate: first.mandate,
      limits: {
        cap: Number(first.limits.cap),
        per_tx_max: Number(first.limits.per_tx_max),
        expires_at: Number(first.limits.expires_at),
        merchant: first.limits.merchant,
        purpose: first.limits.purpose,
      },
      kind: first.kind,
      amount: Number(first.amount),
      counterparty: first.counterparty,
      timestamp: 1790106175,
      nonce: Number(first.nonce),
      reason_code: first.reason_code,
      reason_text: first.reason_text,
      suggested_override: Number(first.suggested_override),
      signature: firstSig,
    })),
  });
  const earlier = await assessRecord(first, DEVNET_RPC, built.conn, OPTS);
  const later = await assessRecord(second, DEVNET_RPC, built.conn, OPTS);
  const tampered = await assessRecord(forged, DEVNET_RPC, built.conn, OPTS);
  assert.equal(later.ok, true, later.text);
  assert.equal(earlier.ok, true, earlier.text);
  assert.equal(tampered.ok, false, tampered.text);
  assert.match(tampered.text, /VERDICT: REJECTED/);
  assert.match(tampered.text, /1790106172/);
  assert.match(tampered.text, /1790106175/);
});

test("issue 117: a devnet record labelled mainnet-beta is rejected", async () => {
  const { conn, records } = devnetWorld();
  const genuine = records.find((row) => row.signature === SINGLE_SIG);
  assert.ok(genuine);
  assert.equal(genuine.genesis_hash, DEVNET_GENESIS);
  const held = await assessRecord(genuine, DEVNET_RPC, conn, OPTS);
  assert.equal(held.ok, true, held.text);
  const relabelled = parseRecord({
    schema_version: 1,
    cluster: "mainnet-beta",
    genesis_hash: genuine.genesis_hash,
    program_id: genuine.program_id,
    mandate: genuine.mandate,
    limits: {
      cap: Number(genuine.limits.cap),
      per_tx_max: Number(genuine.limits.per_tx_max),
      expires_at: Number(genuine.limits.expires_at),
      merchant: genuine.limits.merchant,
      purpose: genuine.limits.purpose,
    },
    kind: genuine.kind,
    amount: Number(genuine.amount),
    counterparty: genuine.counterparty,
    timestamp: Number(genuine.timestamp),
    nonce: Number(genuine.nonce),
    reason_code: genuine.reason_code,
    reason_text: genuine.reason_text,
    suggested_override: Number(genuine.suggested_override),
    signature: genuine.signature,
  });
  const result = await assessRecord(relabelled, DEVNET_RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.match(result.text, /mainnet-beta/);
  assert.match(result.text, /devnet/);
  assert.match(result.text, new RegExp(DEVNET_GENESIS));
});

test("issue 120: verify does not print a keyed RPC query string", async () => {
  const { conn, records } = devnetWorld();
  const genuine = records.find((row) => row.signature === SINGLE_SIG);
  assert.ok(genuine);
  const result = await assessRecord(genuine, KEYED_RPC, conn, OPTS);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.text.includes("SECRET123"), false, result.text);
  assert.equal(result.text.includes("api-key"), false, result.text);
  assert.match(result.text, /rpc\s+https:\/\/rpc\.example\.test\b/);
});
