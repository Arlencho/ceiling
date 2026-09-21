/** Critic round 2 fixtures. Each case names the failure path it exercises. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STALE_AFTER_MS } from "./cadence.js";
import { loadConfig } from "./config.js";
import type { PriceFeed } from "./feed.js";
import { JsonlJournal, type JournalRow } from "./journal.js";
import {
  RECOVERED_SIGNATURE,
  repairJournalFromChain,
  type ChainDecision,
} from "./journalRepair.js";
import {
  hydrateLocalJournal,
  memoryStore,
  objectUpdatedAt,
  persistRecordedDecision,
  type JournalObjectStore,
} from "./journalStore.js";
import { processWindow, type ProcessResult } from "./run.js";
import { isJournalStale } from "./stale.js";

const windowStart = "2026-09-20T00:00:00+02:00";
const laterWindowStart = "2026-09-20T06:00:00+02:00";
const PAID_NONCE = 1789855200n;
const LATER_NONCE = 1789876800n;
const HOUR = 60 * 60 * 1000;
const POLICY = fileURLToPath(
  new URL("../../infra/watcher-silent-alert.yaml", import.meta.url),
);

const IDENTITIES = {
  VETO_RPC: "http://rpc.test",
  VETO_PROGRAM_ID: "Prog",
  VETO_MINT: "Mint",
  VETO_OWNER: "Owner",
  VETO_OWNER_TOKEN: "OwnerToken",
  VETO_MERCHANT: "Merchant",
  VETO_MERCHANT_TOKEN: "MerchantToken",
  VETO_AGENT: "Agent",
};

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "veto-critic-r2-"));
}

function feedWith(timeStart: string, sek: string): PriceFeed {
  return {
    async getWindow() {
      return {
        timeStart,
        timeEnd: timeStart.replace("00:00:00", "00:15:00").replace("06:00:00", "06:15:00"),
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

function refusedSubmit(calls: { n: number }) {
  return async () => {
    calls.n += 1;
    return {
      decision: "refused" as const,
      reason: "over per-payment maximum",
      reasonCode: 5,
      suggestedOverride: 519_500n,
      signature: `refuse-sig-${calls.n}`,
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

function refusedOnChain(nonce = PAID_NONCE): ChainDecision {
  return {
    nonce,
    decision: "refused",
    amount: 519500n,
    ts: new Date("2026-09-20T00:00:05.000Z"),
    reason: 5,
    suggestedOverride: 519500n,
  };
}

function failingUpload(base: JournalObjectStore): JournalObjectStore {
  return {
    download: () => base.download(),
    async upload() {
      throw new Error("journal store: upload failed status=500");
    },
    updatedAt: () => (base.updatedAt !== undefined ? base.updatedAt() : Promise.resolve(null)),
  };
}

function paidRow(): JournalRow {
  return {
    ts: "2026-09-20T00:00:05.000Z",
    window_start: windowStart,
    window_end: null,
    sek_per_kwh: "0.00892",
    kwh_milli: "50000",
    amount: "446000",
    nonce: PAID_NONCE.toString(),
    decision: "paid",
    reason: "ok",
    reason_code: 0,
    signature: "sig-1",
    suggested_override: null,
  };
}

/** Same order as index.ts withJournalAndFeed then processAt, without RPC. */
async function cloudOnce(args: {
  path: string;
  store: JournalObjectStore;
  chain: ChainDecision[];
  at: Date;
  feed: PriceFeed;
  submit: ReturnType<typeof paidSubmit>;
}): Promise<{ exit: 0 | 1; message: string | null; result: ProcessResult | null }> {
  try {
    await hydrateLocalJournal(args.path, args.store);
    const journal = new JsonlJournal(args.path);
    const repaired = repairJournalFromChain(journal, args.chain);
    if (repaired > 0) {
      const rows = journal.load();
      await persistRecordedDecision(args.path, args.store, rows[rows.length - 1] ?? null);
    }
    const prior = journal.load().length;
    const result = await processWindow({
      at: args.at,
      feed: args.feed,
      journal,
      submit: args.submit,
      kwhMilli: 50_000n,
      mintDecimals: 6,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
    });
    const rows = journal.load();
    const last = rows.length > prior ? rows[rows.length - 1] : null;
    await persistRecordedDecision(args.path, args.store, last);
    return { exit: 0, message: null, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exit: 1, message, result: null };
  }
}

test("kill persist after paid: run exits 1 naming the decision; next run repairs and does not resubmit", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore("");
  const calls = { n: 0 };
  const first = await cloudOnce({
    path,
    store: failingUpload(store),
    chain: [],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.00892"),
    submit: paidSubmit(calls),
  });
  assert.equal(first.exit, 1);
  assert.equal(first.message, "could not record paid nonce=1789855200 sig=sig-1");
  assert.equal(await store.download(), "");
  assert.equal(calls.n, 1);

  const retryPath = join(dir, "retry.jsonl");
  const second = await cloudOnce({
    path: retryPath,
    store,
    chain: [paidOnChain()],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.00892"),
    submit: paidSubmit(calls),
  });
  assert.equal(second.exit, 0);
  assert.equal(second.result, "skipped");
  assert.equal(calls.n, 1);
  const retry = new JsonlJournal(retryPath);
  assert.equal(retry.hasNonce(PAID_NONCE), true);
  assert.equal(retry.load()[0]?.signature, RECOVERED_SIGNATURE);
  assert.match(await store.download() ?? "", /"decision":"paid"/);
});

test("kill persist after refused: run exits 1 naming the decision; next run repairs and does not resubmit", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore("");
  const calls = { n: 0 };
  const first = await cloudOnce({
    path,
    store: failingUpload(store),
    chain: [],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.01039"),
    submit: refusedSubmit(calls),
  });
  assert.equal(first.exit, 1);
  assert.equal(first.message, "could not record refused nonce=1789855200 sig=refuse-sig-1");
  assert.equal(await store.download(), "");
  assert.equal(calls.n, 1);

  const retryPath = join(dir, "retry.jsonl");
  const second = await cloudOnce({
    path: retryPath,
    store,
    chain: [refusedOnChain()],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.01039"),
    submit: refusedSubmit(calls),
  });
  assert.equal(second.exit, 0);
  assert.equal(second.result, "skipped");
  assert.equal(calls.n, 1);
  const retry = new JsonlJournal(retryPath);
  assert.equal(retry.hasNonce(PAID_NONCE), true);
  assert.equal(retry.load()[0]?.decision, "refused");
  assert.equal(retry.load()[0]?.signature, RECOVERED_SIGNATURE);
});

test("object behind the chain: hydrate repairs missing rows, does not resubmit, does not discard", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore(`${JSON.stringify(paidRow())}\n`);
  const calls = { n: 0 };
  const run = await cloudOnce({
    path,
    store,
    chain: [paidOnChain(PAID_NONCE), refusedOnChain(LATER_NONCE)],
    at: new Date(laterWindowStart),
    feed: feedWith(laterWindowStart, "0.01039"),
    submit: refusedSubmit(calls),
  });
  assert.equal(run.exit, 0);
  assert.equal(run.result, "skipped");
  assert.equal(calls.n, 0);
  const journal = new JsonlJournal(path);
  const rows = journal.load();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.decision, "paid");
  assert.equal(rows[0]?.signature, "sig-1");
  assert.equal(rows[1]?.decision, "refused");
  assert.equal(rows[1]?.nonce, LATER_NONCE.toString());
  assert.equal(rows[1]?.signature, RECOVERED_SIGNATURE);
  assert.equal(journal.hasNonce(PAID_NONCE), true);
  assert.equal(journal.hasNonce(LATER_NONCE), true);
});

test("cmdStale emptySince is the object updated time, not the local file the checker just wrote", async () => {
  const path = join(tmpDir(), "decisions.jsonl");
  const objectCreated = new Date(Date.now() - 10 * HOUR);
  const store = memoryStore("", objectCreated);
  await hydrateLocalJournal(path, store);
  assert.equal(existsSync(path), true);
  const localMtime = statSync(path).mtime;
  const fromObject = await objectUpdatedAt(store);
  const emptySince = store !== null ? fromObject : localMtime;
  assert.equal(emptySince?.getTime(), objectCreated.getTime());
  assert.notEqual(emptySince?.getTime(), localMtime.getTime());
  assert.equal(isJournalStale({ rows: [], now: new Date(), emptySince: localMtime }), false);
  assert.equal(isJournalStale({ rows: [], now: new Date(), emptySince }), true);
  assert.ok(STALE_AFTER_MS === 9 * HOUR);
});

test("loadConfig still defaults to a local journal file with no GCS URI", () => {
  const dir = tmpDir();
  const file = join(dir, ".env");
  writeFileSync(
    file,
    Object.entries(IDENTITIES)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const cfg = loadConfig({ VETO_KEYS_DIR: dir }, { envFiles: [file] });
  assert.equal(cfg.journalGcsUri, null);
  assert.match(cfg.journalPath, /decisions\.jsonl$/);
});

test("never-executed stale job: the query that must fire is PromQL absent of completed_execution_count", () => {
  const text = readFileSync(POLICY, "utf8");
  const query =
    'absent({"run.googleapis.com/job/completed_execution_count", monitored_resource="cloud_run_job", job_name="veto-watcher-stale"})';
  assert.equal(text.includes(query), true, `missing query: ${query}`);
  assert.equal(text.includes("disableMetricValidation: true"), true);
  assert.equal(text.includes("conditionAbsent"), false);
});

test("watcher ran once then stopped: failed-stale threshold is the query that fires while the stale job still runs", () => {
  const text = readFileSync(POLICY, "utf8");
  assert.match(
    text,
    /resource\.labels\.job_name = "veto-watcher-stale"/,
  );
  assert.match(text, /metric\.labels\.result = "failed"/);
  assert.match(text, /COMPARISON_GT/);
});

test("stale job ran once then stopped: the same PromQL absent query is the one that fires", () => {
  const text = readFileSync(POLICY, "utf8");
  assert.match(text, /duration: 32400s/);
  assert.match(
    text,
    /absent\(\{"run\.googleapis\.com\/job\/completed_execution_count"/,
  );
});

test("PromQL condition is the only condition in the silent-job policy", () => {
  const text = readFileSync(POLICY, "utf8");
  const hasPromql = /conditionPrometheusQueryLanguage:/.test(text);
  const hasThreshold = /conditionThreshold:/.test(text);
  assert.equal(hasPromql, true, "decision two requires the PromQL absent query");
  assert.equal(
    hasThreshold,
    false,
    "GCP: an alerting policy that uses PromQL must have only one condition (https://docs.cloud.google.com/monitoring/promql/create-promql-alerts)",
  );
});
