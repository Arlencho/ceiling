import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
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
