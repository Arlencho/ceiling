import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { mandatePda } from "./chain.js";
import { STALE_AFTER_MS } from "./cadence.js";
import type { PriceFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import {
  decodeLedgerDecisions,
  fetchChainDecisions,
  RECOVERED_SIGNATURE,
  repairJournalFromChain,
  type ChainDecision,
} from "./journalRepair.js";
import {
  hydrateLocalJournal,
  memoryStore,
  objectUpdatedAt,
  persistFailureLine,
  persistRecordedDecision,
} from "./journalStore.js";
import { processWindow } from "./run.js";
import { isJournalStale } from "./stale.js";

const windowStart = "2026-09-20T00:00:00+02:00";
const PAID_NONCE = 1789855200n;
const HOUR = 60 * 60 * 1000;
const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "veto-repair-"));
}

function feedWith(sek: string): PriceFeed {
  return {
    async getWindow() {
      return {
        timeStart: windowStart,
        timeEnd: "2026-09-20T00:15:00+02:00",
        sekPerKwh: sek,
      };
    },
  };
}

function paidSubmit(calls: { n: number }) {
  return async () => {
    calls.n += 1;
    return {
      decision: "paid" as const,
      reason: "ok",
      reasonCode: 0,
      suggestedOverride: null,
      signature: `sig-${calls.n}`,
    };
  };
}

function paidOnChain(nonce = PAID_NONCE): ChainDecision {
  return {
    nonce,
    decision: "paid",
    amount: 446000n,
    ts: new Date("2026-09-20T00:00:05.000Z"),
    reason: 0,
    suggestedOverride: 0n,
  };
}

test("persistFailureLine names the decision the write could not record", () => {
  assert.equal(
    persistFailureLine({ decision: "paid", nonce: "1789855200", signature: "sig-1" }),
    "could not record paid nonce=1789855200 sig=sig-1",
  );
  assert.equal(
    persistFailureLine({ decision: "refused", nonce: "9", signature: null }),
    "could not record refused nonce=9 sig=-",
  );
});

test("a failed write after a paid chain decision fails the run naming that decision", async () => {
  const path = join(tmpDir(), "decisions.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({
      ts: "2026-09-20T00:00:05.000Z",
      window_start: windowStart,
      window_end: null,
      sek_per_kwh: "0.00892",
      kwh_milli: "50000",
      amount: "446000",
      nonce: "1789855200",
      decision: "paid",
      reason: "ok",
      reason_code: 0,
      signature: "sig-1",
      suggested_override: null,
    })}\n`,
  );
  const store = {
    async download() {
      return "";
    },
    async upload() {
      throw new Error("journal store: upload failed status=500");
    },
  };
  const row = {
    decision: "paid" as const,
    nonce: "1789855200",
    signature: "sig-1",
  };
  await assert.rejects(
    () => persistRecordedDecision(path, store, row),
    /could not record paid nonce=1789855200 sig=sig-1/,
  );
});

test("hydrate of an empty object repairs a paid row from chain before processWindow", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore("");
  await hydrateLocalJournal(path, store);
  const journal = new JsonlJournal(path);
  assert.equal(journal.hasNonce(PAID_NONCE), false);

  const n = repairJournalFromChain(journal, [paidOnChain()]);
  assert.equal(n, 1);
  assert.equal(journal.hasNonce(PAID_NONCE), true);
  assert.equal(journal.maxSettledNonce(), PAID_NONCE);
  assert.equal(journal.load()[0]?.signature, RECOVERED_SIGNATURE);

  const calls = { n: 0 };
  const result = await processWindow({
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    submit: paidSubmit(calls),
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  });
  assert.equal(result, "skipped");
  assert.equal(calls.n, 0);
});

test("repair does not duplicate a nonce the journal already has", () => {
  const journal = new JsonlJournal(join(tmpDir(), "decisions.jsonl"));
  journal.append({
    ts: "2026-09-20T00:00:05.000Z",
    window_start: windowStart,
    window_end: null,
    sek_per_kwh: "0.00892",
    kwh_milli: "50000",
    amount: "446000",
    nonce: "1789855200",
    decision: "paid",
    reason: "ok",
    reason_code: 0,
    signature: "sig-1",
    suggested_override: null,
  });
  assert.equal(repairJournalFromChain(journal, [paidOnChain()]), 0);
  assert.equal(journal.load().length, 1);
});

test("stale emptySince comes from the object updated time, not the local file mtime", async () => {
  const path = join(tmpDir(), "decisions.jsonl");
  const objectCreated = new Date(Date.now() - 10 * HOUR);
  const store = memoryStore("", objectCreated);
  await hydrateLocalJournal(path, store);
  const localMtime = statSync(path).mtime;
  assert.equal(isJournalStale({ rows: [], now: new Date(), emptySince: localMtime }), false);

  const fromObject = await objectUpdatedAt(store);
  assert.equal(fromObject?.getTime(), objectCreated.getTime());
  assert.equal(isJournalStale({ rows: [], now: new Date(), emptySince: fromObject }), true);
  assert.ok(STALE_AFTER_MS === 9 * HOUR);
});

test("hydrate of an empty object does not refresh the object updated time", async () => {
  const path = join(tmpDir(), "decisions.jsonl");
  const objectCreated = new Date("2026-09-21T00:00:00.000Z");
  const store = memoryStore("", objectCreated);
  await hydrateLocalJournal(path, store);
  utimesSync(path, new Date(), new Date());
  assert.equal((await objectUpdatedAt(store))?.toISOString(), objectCreated.toISOString());
  assert.equal(readFileSync(path, "utf8"), "");
});

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

test("decodeLedgerDecisions keeps paid and refused ring rows and drops opened", () => {
  const data = ledgerBytes([
    { kind: 0, nonce: 0n, amount: 100000000n, ts: 1n, reason: 0 },
    { kind: 1, nonce: PAID_NONCE, amount: 446000n, ts: 1789855205n, reason: 0 },
    { kind: 2, nonce: 1789860600n, amount: 519500n, ts: 1789860605n, reason: 5 },
  ]);
  const rows = decodeLedgerDecisions(data);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.decision, "paid");
  assert.equal(rows[0]?.nonce, PAID_NONCE);
  assert.equal(rows[1]?.decision, "refused");
  assert.equal(rows[1]?.reason, 5);
});

const CHARGE_DISC = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function chargeTx(args: {
  programId: PublicKey;
  amount: bigint;
  nonce: bigint;
  logs: string[];
  blockTime: number;
}) {
  return {
    slot: 1,
    blockTime: args.blockTime,
    transaction: {
      message: {
        staticAccountKeys: [PublicKey.default, PublicKey.default, args.programId],
        compiledInstructions: [
          {
            programIdIndex: 2,
            accountKeyIndexes: [] as number[],
            data: Buffer.concat([CHARGE_DISC, u64(args.amount), u64(args.nonce)]),
          },
        ],
      },
    },
    meta: {
      err: null,
      logMessages: args.logs,
      loadedAddresses: { writable: [] as PublicKey[], readonly: [] as PublicKey[] },
    },
  };
}

test("a rebuilt row names the signature of the transaction the walk found", async () => {
  const programId = new PublicKey(Buffer.alloc(32, 1));
  const owner = new PublicKey(Buffer.alloc(32, 2));
  const mandate = mandatePda(programId, owner, 1n);
  const paidSig = "paid-sig-from-history";
  const asked: string[] = [];
  const data = ledgerBytes([
    { kind: 1, nonce: PAID_NONCE, amount: 446000n, ts: 1789855205n, reason: 0 },
  ]);
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return { data };
      },
      async getSignaturesForAddress(address: PublicKey) {
        asked.push(address.toBase58());
        return [{ signature: paidSig, err: null, blockTime: 1789855205 }];
      },
      async getTransaction() {
        return chargeTx({
          programId,
          amount: 446000n,
          nonce: PAID_NONCE,
          logs: ["Program log: VETO PAID amount=446000"],
          blockTime: 1789855205,
        });
      },
    },
    programId,
    owner,
    mandateId: 1n,
  });
  assert.deepEqual(asked, [mandate.toBase58()]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.decision, "paid");
  assert.equal(entries[0]?.amount, 446000n);
  assert.equal(entries[0]?.signature, paidSig);

  const journal = new JsonlJournal(join(tmpDir(), "decisions.jsonl"));
  assert.equal(repairJournalFromChain(journal, entries), 1);
  const row = journal.load()[0];
  assert.equal(row?.signature, paidSig);
  assert.equal(row?.decision, "paid");
  assert.equal(row?.amount, "446000");
});

test("a rebuilt row keeps recovered-from-chain when the walk cannot find the transaction", async () => {
  const programId = new PublicKey(Buffer.alloc(32, 3));
  const owner = new PublicKey(Buffer.alloc(32, 4));
  const data = ledgerBytes([
    { kind: 1, nonce: PAID_NONCE, amount: 446000n, ts: 1789855205n, reason: 0 },
  ]);
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return { data };
      },
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        throw new Error("the walk found no signature, so no transaction is read");
      },
    },
    programId,
    owner,
    mandateId: 1n,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.signature, undefined);
  assert.equal(entries[0]?.decision, "paid");
  assert.equal(entries[0]?.amount, 446000n);
  const journal = new JsonlJournal(join(tmpDir(), "decisions.jsonl"));
  repairJournalFromChain(journal, entries);
  const row = journal.load()[0];
  assert.equal(row?.signature, RECOVERED_SIGNATURE);
  assert.equal(row?.decision, "paid");
  assert.equal(row?.amount, "446000");
});

test("a refused charge the ring has lost is rebuilt from the transaction, signature included", async () => {
  const programId = new PublicKey(Buffer.alloc(32, 5));
  const owner = new PublicKey(Buffer.alloc(32, 6));
  const nonce = 1789860600n;
  const refusedSig = "refused-sig-from-history";
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return null;
      },
      async getSignaturesForAddress() {
        return [{ signature: refusedSig, err: null, blockTime: 1789860605 }];
      },
      async getTransaction() {
        return chargeTx({
          programId,
          amount: 6232500n,
          nonce,
          logs: [
            "Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=1 override_to_clear=100",
          ],
          blockTime: 1789860605,
        });
      },
    },
    programId,
    owner,
    mandateId: 1n,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.decision, "refused");
  assert.equal(entries[0]?.amount, 6232500n);
  assert.equal(entries[0]?.reason, 5);
  assert.equal(entries[0]?.suggestedOverride, 100n);
  assert.equal(entries[0]?.signature, refusedSig);
  const journal = new JsonlJournal(join(tmpDir(), "decisions.jsonl"));
  repairJournalFromChain(journal, entries);
  const row = journal.load()[0];
  assert.equal(row?.signature, refusedSig);
  assert.equal(row?.decision, "refused");
  assert.equal(row?.amount, "6232500");
  assert.equal(row?.suggested_override, "100");
});

test("a history walk that throws still repairs from the ring with the placeholder signature", async () => {
  const programId = new PublicKey(Buffer.alloc(32, 7));
  const owner = new PublicKey(Buffer.alloc(32, 8));
  const data = ledgerBytes([
    { kind: 2, nonce: PAID_NONCE, amount: 519500n, ts: 1789855205n, reason: 5 },
  ]);
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return { data };
      },
      async getSignaturesForAddress() {
        throw new Error("rpc down");
      },
      async getTransaction() {
        throw new Error("rpc down");
      },
    },
    programId,
    owner,
    mandateId: 1n,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.signature, undefined);
  assert.equal(entries[0]?.decision, "refused");
  const journal = new JsonlJournal(join(tmpDir(), "decisions.jsonl"));
  repairJournalFromChain(journal, entries);
  assert.equal(journal.load()[0]?.signature, RECOVERED_SIGNATURE);
  assert.equal(journal.load()[0]?.decision, "refused");
});

test("fetchChainDecisions returns empty when the ledger account is missing", async () => {
  const programId = new PublicKey(Buffer.alloc(32, 1));
  const owner = new PublicKey(Buffer.alloc(32, 2));
  const entries = await fetchChainDecisions({
    connection: {
      async getAccountInfo() {
        return null;
      },
    },
    programId,
    owner,
    mandateId: 1n,
  });
  assert.deepEqual(entries, []);
});
