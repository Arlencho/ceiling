/** Critic round 1 fixtures. Each case names the failure path it exercises. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STALE_AFTER_MS } from "./cadence.js";
import type { PriceFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import {
  hydrateLocalJournal,
  memoryStore,
  persistLocalJournal,
  type JournalObjectStore,
} from "./journalStore.js";
import { processWindow } from "./run.js";
import { isJournalStale } from "./stale.js";

const windowStart = "2026-09-20T00:00:00+02:00";
const HOUR = 60 * 60 * 1000;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "veto-critic-r1-"));
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

async function startRun(path: string, store: JournalObjectStore): Promise<void> {
  await hydrateLocalJournal(path, store);
}

test("kill GCS read (503): hydrate throws and the local journal is not created", async () => {
  const path = join(tmpDir(), "decisions.jsonl");
  const store: JournalObjectStore = {
    async download() {
      throw new Error("journal store: download failed status=503");
    },
    async upload() {},
  };
  await assert.rejects(() => startRun(path, store), /download failed status=503/);
  assert.equal(existsSync(path), false);
});

test("kill GCS read (404): hydrate leaves no file and processWindow submits as a first run", async () => {
  const path = join(tmpDir(), "decisions.jsonl");
  const store = memoryStore();
  await startRun(path, store);
  assert.equal(existsSync(path), false);
  const journal = new JsonlJournal(path);
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
  assert.equal(result, "submitted");
  assert.equal(calls.n, 1);
});

test("kill persist after paid: GCS lacks the row the chain just confirmed", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore("");
  await hydrateLocalJournal(path, store);
  const journal = new JsonlJournal(path);
  const calls = { n: 0 };
  assert.equal(
    await processWindow({
      at: new Date(windowStart),
      feed: feedWith("0.00892"),
      journal,
      submit: paidSubmit(calls),
      kwhMilli: 50_000n,
      mintDecimals: 6,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
    }),
    "submitted",
  );
  assert.equal(calls.n, 1);
  assert.match(readFileSync(path, "utf8"), /"decision":"paid"/);

  const failing: JournalObjectStore = {
    download: () => store.download(),
    async upload() {
      throw new Error("journal store: upload failed status=500");
    },
  };
  await assert.rejects(() => persistLocalJournal(path, failing), /upload failed status=500/);
  assert.equal(await store.download(), "");
});

test("kill persist after paid: the next hydrate from GCS resubmits the same window", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore("");
  await hydrateLocalJournal(path, store);
  const journal = new JsonlJournal(path);
  const calls = { n: 0 };
  const args = {
    at: new Date(windowStart),
    feed: feedWith("0.00892"),
    journal,
    submit: paidSubmit(calls),
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
  };
  assert.equal(await processWindow(args), "submitted");
  const failing: JournalObjectStore = {
    download: () => store.download(),
    async upload() {
      throw new Error("journal store: upload failed status=500");
    },
  };
  await assert.rejects(() => persistLocalJournal(path, failing), /upload failed/);

  const retryPath = join(dir, "retry.jsonl");
  await hydrateLocalJournal(retryPath, store);
  const retryJournal = new JsonlJournal(retryPath);
  assert.equal(retryJournal.hasNonce(1789855200n), false);
  assert.equal(await processWindow({ ...args, journal: retryJournal }), "submitted");
  assert.equal(calls.n, 2);
});

test("cmdStale sequence: hydrate of an empty object resets mtime so the hourly check is fresh", async () => {
  const path = join(tmpDir(), "decisions.jsonl");
  const objectCreated = new Date(Date.now() - 10 * HOUR);
  assert.equal(
    isJournalStale({ rows: [], now: new Date(), emptySince: objectCreated }),
    true,
    "a 10-hour-old empty object is stale by STALE_AFTER_MS",
  );

  await hydrateLocalJournal(path, memoryStore(""));
  const emptySince = statSync(path).mtime;
  const rows = new JsonlJournal(path).load();
  assert.equal(rows.length, 0);
  assert.equal(
    isJournalStale({ rows, now: new Date(), emptySince }),
    false,
    "index.ts cmdStale stats the file after hydrate, so an empty object never ages",
  );
  assert.ok(STALE_AFTER_MS === 9 * HOUR);
});
