/** Critic round 4 fixtures. Merge preservation against backup/cloud-run-pre-merge. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
  persistRecordedDecision,
  type JournalObjectStore,
} from "./journalStore.js";
import { processWindow, type ProcessResult } from "./run.js";

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));
const SILENT = fileURLToPath(
  new URL("../../infra/watcher-silent-alert.yaml", import.meta.url),
);
const STALE = fileURLToPath(
  new URL("../../infra/watcher-stale-alert.yaml", import.meta.url),
);

const windowStart = "2026-09-20T00:00:00+02:00";
const laterWindowStart = "2026-09-20T06:00:00+02:00";
const PAID_NONCE = 1789855200n;
const LATER_NONCE = 1789876800n;

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
  return mkdtempSync(join(tmpdir(), "veto-critic-r4-"));
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

function yamlKeys(text: string): string[] {
  return [...text.matchAll(/^[ \t-]*([A-Za-z][A-Za-zA-Z0-9]*):/gm)].map(
    (m) => m[1] ?? "",
  );
}

/** Same order as merged index.ts withJournalAndFeed then processAt. */
async function mergedOnce(args: {
  path: string;
  store: JournalObjectStore;
  chain: ChainDecision[];
  at: Date;
  feed: PriceFeed;
  submit: ReturnType<typeof paidSubmit>;
  chainLastNonce: () => Promise<bigint>;
  recoverSettled?: (nonce: bigint) => Promise<{
    decision: "paid" | "refused";
    reason: string;
    reasonCode: number;
    suggestedOverride: bigint | null;
    signature: string;
    amount: bigint;
  } | null>;
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
      reader: {
        chainLastNonce: args.chainLastNonce,
        recoverSettled: args.recoverSettled ?? (async () => null),
        recordedCharge: async () => null,
      },
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

test("index.ts still passes chainLastNonce and recoverSettled into both processWindow calls", () => {
  const text = readFileSync(INDEX, "utf8");
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf("processWindow({", from);
    if (i < 0) break;
    starts.push(i);
    from = i + 1;
  }
  assert.equal(starts.length, 2, "processAt and processDue each call processWindow");
  for (const start of starts) {
    const block = text.slice(start, start + 500);
    assert.match(block, /chainLastNonce,/);
    assert.match(block, /recoverSettled,/);
  }
  assert.match(text, /const chainLastNonce = \(\) => readLastNonce\(\{ cfg, agent \}\)/);
  assert.match(
    text,
    /const recoverSettled = \(nonce: bigint\) => recoverSettledCharge\(\{ cfg, agent, nonce \}\)/,
  );
});

test("kill persist after paid: run exits 1 naming the decision; next run repairs and does not resubmit", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore("");
  const calls = { n: 0 };
  const first = await mergedOnce({
    path,
    store: failingUpload(store),
    chain: [],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.00892"),
    submit: paidSubmit(calls),
    chainLastNonce: async () => 0n,
    recoverSettled: async () => null,
  });
  assert.equal(first.exit, 1);
  assert.equal(first.message, "could not record paid nonce=1789855200 sig=sig-1");
  assert.equal(await store.download(), "");
  assert.equal(calls.n, 1);

  const retryPath = join(dir, "retry.jsonl");
  const second = await mergedOnce({
    path: retryPath,
    store,
    chain: [paidOnChain()],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.00892"),
    submit: paidSubmit(calls),
    chainLastNonce: async () => PAID_NONCE,
    recoverSettled: async () => {
      throw new Error("repair must skip before recoverSettled");
    },
  });
  assert.equal(second.exit, 0);
  assert.equal(second.result, "skipped");
  assert.equal(calls.n, 1);
  const retry = new JsonlJournal(retryPath);
  assert.equal(retry.hasNonce(PAID_NONCE), true);
  assert.equal(retry.load()[0]?.signature, RECOVERED_SIGNATURE);
  assert.match((await store.download()) ?? "", /"decision":"paid"/);
});

test("kill persist after refused: run exits 1 naming the decision; next run repairs and does not resubmit", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore("");
  const calls = { n: 0 };
  const first = await mergedOnce({
    path,
    store: failingUpload(store),
    chain: [],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.01039"),
    submit: refusedSubmit(calls),
    chainLastNonce: async () => 0n,
    recoverSettled: async () => null,
  });
  assert.equal(first.exit, 1);
  assert.equal(first.message, "could not record refused nonce=1789855200 sig=refuse-sig-1");
  assert.equal(await store.download(), "");
  assert.equal(calls.n, 1);

  const retryPath = join(dir, "retry.jsonl");
  const second = await mergedOnce({
    path: retryPath,
    store,
    chain: [refusedOnChain()],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.01039"),
    submit: refusedSubmit(calls),
    chainLastNonce: async () => 0n,
    recoverSettled: async () => {
      throw new Error("repair must skip before recoverSettled");
    },
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
  const run = await mergedOnce({
    path,
    store,
    chain: [paidOnChain(PAID_NONCE), refusedOnChain(LATER_NONCE)],
    at: new Date(laterWindowStart),
    feed: feedWith(laterWindowStart, "0.01039"),
    submit: refusedSubmit(calls),
    chainLastNonce: async () => PAID_NONCE,
    recoverSettled: async () => {
      throw new Error("repair must skip before recoverSettled");
    },
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

test("settlement is read from the chain: removing the reader resubmits an empty journal", async () => {
  const dir = tmpDir();
  const recovered = {
    decision: "paid" as const,
    reason: "ok",
    reasonCode: 0,
    suggestedOverride: null,
    signature: "recovered-sig",
    amount: 446_000n,
  };

  const withCalls = { n: 0 };
  const withReader = await mergedOnce({
    path: join(dir, "with.jsonl"),
    store: memoryStore(""),
    chain: [],
    at: new Date(windowStart),
    feed: feedWith(windowStart, "0.00892"),
    submit: paidSubmit(withCalls),
    chainLastNonce: async () => PAID_NONCE,
    recoverSettled: async () => recovered,
  });
  assert.equal(withReader.exit, 0);
  assert.equal(withReader.result, "submitted");
  assert.equal(withCalls.n, 0);
  assert.equal(new JsonlJournal(join(dir, "with.jsonl")).load()[0]?.signature, "recovered-sig");

  const withoutCalls = { n: 0 };
  try {
    await hydrateLocalJournal(join(dir, "without.jsonl"), memoryStore(""));
    const journal = new JsonlJournal(join(dir, "without.jsonl"));
    const result = await processWindow({
      at: new Date(windowStart),
      feed: feedWith(windowStart, "0.00892"),
      journal,
      submit: paidSubmit(withoutCalls),
      kwhMilli: 50_000n,
      mintDecimals: 6,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
    });
    assert.equal(result, "submitted");
  } catch (err) {
    assert.fail(err instanceof Error ? err.message : String(err));
  }
  assert.equal(withoutCalls.n, 1);
  assert.notEqual(withCalls.n, withoutCalls.n);
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

test("both alert policies are still a single condition", () => {
  const silent = readFileSync(SILENT, "utf8");
  const stale = readFileSync(STALE, "utf8");
  const silentKeys = yamlKeys(silent);
  const staleKeys = yamlKeys(stale);
  assert.equal(silentKeys.filter((k) => k === "conditionPrometheusQueryLanguage").length, 1);
  assert.equal(silentKeys.includes("conditionThreshold"), false);
  assert.equal(silentKeys.includes("conditionAbsent"), false);
  assert.equal(staleKeys.filter((k) => k === "conditionThreshold").length, 1);
  assert.equal(staleKeys.includes("conditionPrometheusQueryLanguage"), false);
  assert.equal(staleKeys.includes("conditionAbsent"), false);
});
