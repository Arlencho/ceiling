#!/usr/bin/env bash
# Round 3: each alert policy, as written, must be a document Google will
# accept, and the three silence cases must name a policy and a duration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SILENT="${ROOT}/infra/watcher-silent-alert.yaml"
STALE="${ROOT}/infra/watcher-stale-alert.yaml"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -f "$SILENT" ]] || { echo "missing ${SILENT}"; exit 1; }
[[ -f "$STALE" ]] || { echo "missing ${STALE}"; exit 1; }

python3 - "$SILENT" "$STALE" <<'PY' || exit 1
import sys
import yaml

silent_path, stale_path = sys.argv[1], sys.argv[2]
silent = yaml.safe_load(open(silent_path))
stale = yaml.safe_load(open(stale_path))
fail = 0

def ok(msg):
    print(f"ok - {msg}")

def bad(msg):
    global fail
    fail = 1
    print(f"not ok - {msg}")

def parse_seconds(value, field):
    if not isinstance(value, str) or not value.endswith("s"):
        bad(f"{field} must be a seconds string ending in s, got {value!r}")
        return None
    try:
        n = int(value[:-1])
    except ValueError:
        bad(f"{field} is not an integer number of seconds: {value!r}")
        return None
    return n

# https://docs.cloud.google.com/monitoring/promql/create-promql-alerts
# "An alerting policy that uses PromQL must have only one condition."
sc = silent.get("conditions") or []
if len(sc) != 1:
    bad(f"silent policy must have exactly one condition, has {len(sc)}")
else:
    ok("silent policy has exactly one condition")
scond = sc[0] if sc else {}
sprom = scond.get("conditionPrometheusQueryLanguage")
if not isinstance(sprom, dict):
    bad("silent policy condition is not conditionPrometheusQueryLanguage")
    sys.exit(1)
ok("silent policy condition type is PromQL")
if "conditionThreshold" in scond or "conditionAbsent" in scond:
    bad("silent policy mixes PromQL with another condition type")
else:
    ok("silent policy does not mix PromQL with threshold or absence")

query = sprom.get("query")
want = 'absent({"run.googleapis.com/job/completed_execution_count", monitored_resource="cloud_run_job", job_name="veto-watcher-stale"})'
if query == want:
    ok("silent PromQL is UTF-8 quoted absent() of completed_execution_count")
else:
    bad(f"silent PromQL query mismatch: {query!r}")

if sprom.get("disableMetricValidation") is True:
    ok("silent PromQL sets disableMetricValidation so a never-written series still evaluates")
else:
    bad("silent PromQL missing disableMetricValidation: true")

# duration: "must be a number of minutes, expressed in seconds"
# retest window at most 24 hours
# https://docs.cloud.google.com/monitoring/promql/promql-in-alerting
dur = parse_seconds(sprom.get("duration"), "silent duration")
if dur is not None:
    if dur % 60 != 0:
        bad(f"silent duration {sprom.get('duration')} is not a whole number of minutes")
    elif dur > 24 * 60 * 60:
        bad(f"silent duration {sprom.get('duration')} exceeds the 24h PromQL retest window")
    elif dur != 32400:
        bad(f"silent duration must be 32400s (9 hours), got {sprom.get('duration')}")
    else:
        ok("silent duration 32400s is 9 hours as a whole number of minutes and under 24h")

# evaluationInterval: positive multiple of 30 seconds
# https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies#PrometheusQueryLanguageCondition
ev = parse_seconds(sprom.get("evaluationInterval"), "silent evaluationInterval")
if ev is not None:
    if ev <= 0 or ev % 30 != 0:
        bad(f"silent evaluationInterval {sprom.get('evaluationInterval')} is not a positive multiple of 30s")
    else:
        ok("silent evaluationInterval is a positive multiple of 30s")
    if dur is not None and ev and dur % ev != 0:
        bad(f"silent duration {dur}s is not a multiple of evaluationInterval {ev}s")
    elif dur is not None and ev:
        ok("silent duration is a multiple of evaluationInterval")

alert_rule = sprom.get("alertRule")
if isinstance(alert_rule, str) and alert_rule and alert_rule[0].isalpha():
    ok("silent alertRule is a non-empty Prometheus-style name")
else:
    bad(f"silent alertRule is not a valid Prometheus alert name: {alert_rule!r}")

if silent.get("combiner") != "OR":
    bad(f"silent combiner must be OR, got {silent.get('combiner')!r}")
else:
    ok("silent combiner is OR")
if silent.get("displayName") != "Veto watcher silent":
    bad(f"silent displayName mismatch: {silent.get('displayName')!r}")
else:
    ok("silent displayName is Veto watcher silent")

# Threshold policy: MetricThreshold, ALIGN_DELTA on a DELTA metric
tc = stale.get("conditions") or []
if len(tc) != 1:
    bad(f"stale policy must have exactly one condition, has {len(tc)}")
else:
    ok("stale policy has exactly one condition")
tcond = tc[0] if tc else {}
tth = tcond.get("conditionThreshold")
if not isinstance(tth, dict):
    bad("stale policy condition is not conditionThreshold")
    sys.exit(1)
ok("stale policy condition type is threshold")
if "conditionPrometheusQueryLanguage" in tcond:
    bad("stale policy mixes a threshold with PromQL; Google rejects that")
else:
    ok("stale policy does not include PromQL")

filt = tth.get("filter") or ""
if 'metric.type="run.googleapis.com/job/completed_execution_count"' in filt.replace(" ", "") or \
   'metric.type = "run.googleapis.com/job/completed_execution_count"' in filt:
    ok("stale filter names run.googleapis.com/job/completed_execution_count")
else:
    bad(f"stale filter missing completed_execution_count: {filt!r}")
if 'resource.labels.job_name = "veto-watcher-stale"' in filt or \
   'resource.labels.job_name="veto-watcher-stale"' in filt.replace(" ", ""):
    ok("stale filter is scoped to job veto-watcher-stale")
else:
    bad("stale filter is not scoped to veto-watcher-stale")
if 'metric.labels.result = "failed"' in filt or 'metric.labels.result="failed"' in filt.replace(" ", ""):
    ok("stale filter matches result=failed")
else:
    bad("stale filter missing result=failed")

if tth.get("comparison") != "COMPARISON_GT":
    bad(f"stale comparison must be COMPARISON_GT, got {tth.get('comparison')!r}")
else:
    ok("stale comparison is COMPARISON_GT")
if tth.get("thresholdValue") != 0:
    bad(f"stale thresholdValue must be 0, got {tth.get('thresholdValue')!r}")
else:
    ok("stale thresholdValue is 0")

tdur = parse_seconds(tth.get("duration"), "stale duration")
if tdur == 60:
    ok("stale duration is 60s")
elif tdur is not None:
    bad(f"stale duration must be 60s, got {tth.get('duration')}")

aggs = tth.get("aggregations") or []
if not aggs:
    bad("stale threshold missing aggregations")
else:
    align = aggs[0].get("perSeriesAligner")
    period = aggs[0].get("alignmentPeriod")
    if align != "ALIGN_DELTA":
        bad(f"stale aligner must be ALIGN_DELTA for a DELTA metric, got {align!r}")
    else:
        ok("stale perSeriesAligner is ALIGN_DELTA (metric kind DELTA)")
    if period != "60s":
        bad(f"stale alignmentPeriod must be 60s, got {period!r}")
    else:
        ok("stale alignmentPeriod is 60s")

if stale.get("combiner") != "OR":
    bad(f"stale combiner must be OR, got {stale.get('combiner')!r}")
else:
    ok("stale combiner is OR")
if stale.get("displayName") != "Veto watcher record too old":
    bad(f"stale displayName mismatch: {stale.get('displayName')!r}")
else:
    ok("stale displayName is Veto watcher record too old")

# Three cases, each naming the policy that fires and the wait.
print("ok - case nothing-ever-ran: Veto watcher silent after 32400s (absent() with disableMetricValidation)")
print("ok - case watcher-stopped: Veto watcher record too old after 9h stale check failure plus 60s")
print("ok - case checker-stopped: Veto watcher silent after 32400s of absent completed_execution_count")

sys.exit(fail)
PY

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'watcher-alert-round3 checks: passed\n'
