/** Critic round 3 fixtures. Each case names the failure path it exercises. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SILENT = fileURLToPath(
  new URL("../../infra/watcher-silent-alert.yaml", import.meta.url),
);
const STALE = fileURLToPath(
  new URL("../../infra/watcher-stale-alert.yaml", import.meta.url),
);

const ABSENT_QUERY =
  'absent({"run.googleapis.com/job/completed_execution_count", monitored_resource="cloud_run_job", job_name="veto-watcher-stale"})';

function yamlKeys(text: string): string[] {
  return [...text.matchAll(/^[ \t-]*([A-Za-z][A-Za-zA-Z0-9]*):/gm)].map(
    (m) => m[1] ?? "",
  );
}

test("silent policy is PromQL-only so Google will accept it", () => {
  const text = readFileSync(SILENT, "utf8");
  const keys = yamlKeys(text);
  assert.equal(keys.filter((k) => k === "conditionPrometheusQueryLanguage").length, 1);
  assert.equal(keys.includes("conditionThreshold"), false);
  assert.equal(keys.includes("conditionAbsent"), false);
  assert.equal(text.includes(ABSENT_QUERY), true);
  assert.match(text, /disableMetricValidation: true/);
  assert.match(text, /duration: 32400s/);
  assert.match(text, /evaluationInterval: 3600s/);
  assert.match(text, /^combiner: OR$/m);
  assert.match(text, /^displayName: Veto watcher silent$/m);
});

test("record-too-old policy is a single threshold so Google will accept it", () => {
  const text = readFileSync(STALE, "utf8");
  const keys = yamlKeys(text);
  assert.equal(keys.filter((k) => k === "conditionThreshold").length, 1);
  assert.equal(keys.includes("conditionPrometheusQueryLanguage"), false);
  assert.equal(keys.includes("conditionAbsent"), false);
  assert.match(text, /metric\.labels\.result = "failed"/);
  assert.match(text, /resource\.labels\.job_name = "veto-watcher-stale"/);
  assert.match(text, /metric\.type = "run\.googleapis\.com\/job\/completed_execution_count"/);
  assert.match(text, /comparison: COMPARISON_GT/);
  assert.match(text, /thresholdValue: 0/);
  assert.match(text, /duration: 60s/);
  assert.match(text, /perSeriesAligner: ALIGN_DELTA/);
  assert.match(text, /^combiner: OR$/m);
  assert.match(text, /^displayName: Veto watcher record too old$/m);
});

test("nothing ever ran: Veto watcher silent fires after 32400s", () => {
  const silent = readFileSync(SILENT, "utf8");
  const stale = readFileSync(STALE, "utf8");
  assert.equal(silent.includes(ABSENT_QUERY), true);
  assert.match(silent, /disableMetricValidation: true/);
  assert.match(silent, /duration: 32400s/);
  assert.equal(/conditionThreshold:/.test(stale), true);
  assert.equal(/conditionPrometheusQueryLanguage:/.test(stale), false);
});

test("watcher stopped, checker kept going: Veto watcher record too old fires after 9 hours plus 60s", () => {
  const stale = readFileSync(STALE, "utf8");
  const keys = yamlKeys(stale);
  assert.equal(keys.includes("conditionThreshold"), true);
  assert.match(stale, /result = "failed"/);
  assert.match(stale, /COMPARISON_GT/);
  assert.match(stale, /duration: 60s/);
});

test("checker stopped: Veto watcher silent fires after 32400s of absent completed_execution_count", () => {
  const silent = readFileSync(SILENT, "utf8");
  assert.equal(silent.includes(ABSENT_QUERY), true);
  assert.match(silent, /duration: 32400s/);
  assert.equal(/conditionAbsent:/.test(silent), false);
});
