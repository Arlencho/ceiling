// Issue 98: a repair reads transactions only until every ring nonce the
// journal is missing has been found. A rebuild from nothing still reads
// every transaction. The assertions count reads. They do not name signatures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { fetchChainDecisions } from "./journalRepair.js";

const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const CHARGE_DISC = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);

function ledgerBytes(entries: Array<{ kind: number; nonce: bigint; amount: bigint; ts: bigint; reason: number }>): Buffer {
  const data = Buffer.alloc(8 + 40 + 32 * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(entries.length, 8 + 32);
  data.writeUInt16LE(entries.length, 8 + 36);
  for (let i = 0; i < entries.length; i++) {
    const off = 8 + 40 + i * 72;
    const e = entries[i]!;
    data.writeBigInt64LE(e.ts, off);
    data.writeBigUInt64LE(e.amount, off + 8);
    data.writeBigUInt64LE(e.nonce, off + 48);
    data[off + 64] = e.kind;
    data[off + 65] = e.reason;
  }
  return data;
}

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function chargeTx(programId: PublicKey, amount: bigint, nonce: bigint, blockTime: number) {
  return {
    slot: 1,
    blockTime,
    transaction: {
      message: {
        staticAccountKeys: [PublicKey.default, PublicKey.default, programId],
        compiledInstructions: [
          { programIdIndex: 2, accountKeyIndexes: [] as number[], data: Buffer.concat([CHARGE_DISC, u64(amount), u64(nonce)]) },
        ],
      },
    },
    meta: {
      err: null,
      logMessages: [`Program log: VETO PAID amount=${amount.toString()}`],
      loadedAddresses: { writable: [] as PublicKey[], readonly: [] as PublicKey[] },
    },
  };
}

const programId = new PublicKey(Buffer.alloc(32, 9));
const owner = new PublicKey(Buffer.alloc(32, 10));
const N1 = 1789855200n;
const N2 = 1789858800n;
const N3 = 1789862400n;
const N0 = 1789851600n;

const RING = ledgerBytes([
  { kind: 1, nonce: N1, amount: 446000n, ts: 1789855205n, reason: 0 },
  { kind: 2, nonce: N2, amount: 6232500n, ts: 1789858805n, reason: 5 },
  { kind: 1, nonce: N3, amount: 501000n, ts: 1789862405n, reason: 0 },
]);

// Newest first, as getSignaturesForAddress returns them. N0 is older than
// the ring, so a walk that stops at the ring never reads it.
const HISTORY = [
  { signature: "sig-n3", nonce: N3, amount: 501000n, blockTime: 1789862405 },
  { signature: "sig-n2", nonce: N2, amount: 6232500n, blockTime: 1789858805 },
  { signature: "sig-n1", nonce: N1, amount: 446000n, blockTime: 1789855205 },
  { signature: "sig-n0", nonce: N0, amount: 100000n, blockTime: 1789851605 },
];

function countReads(hasNonce?: (nonce: bigint) => boolean): Promise<number> {
  let txs = 0;
  const entries = fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return { data: RING };
      },
      async getSignaturesForAddress() {
        return HISTORY.map((row) => ({ signature: row.signature, err: null, blockTime: row.blockTime }));
      },
      async getTransaction(signature: string) {
        txs += 1;
        const row = HISTORY.find((item) => item.signature === signature);
        if (row === undefined) return null;
        return chargeTx(programId, row.amount, row.nonce, row.blockTime);
      },
    },
    programId,
    owner,
    mandateId: 1n,
    ...(hasNonce === undefined ? {} : { hasNonce }),
  });
  return entries.then(() => txs);
}

test("a repair stops reading once every journal entry it is missing has been found", async () => {
  const reads = await countReads((nonce) => nonce === N1 || nonce === N2);
  assert.equal(reads, 1);
});

test("a rebuild from nothing reads every transaction in the history", async () => {
  const fromEmptyJournal = await countReads(() => false);
  const withNoHeldSet = await countReads(undefined);
  assert.equal(fromEmptyJournal, HISTORY.length);
  assert.equal(withNoHeldSet, HISTORY.length);
});
