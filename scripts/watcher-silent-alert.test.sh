#!/usr/bin/env bash
# The silent-job alert must fire when the watcher has never once executed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY="${ROOT}/infra/watcher-silent-alert.yaml"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -f "$POLICY" ]] || { echo "missing ${POLICY}"; exit 1; }

if grep -q 'conditionThreshold' "$POLICY" \
  && grep -q 'metric.labels.result = "failed"' "$POLICY"; then
  pass "policy fires when the stale check fails (record too old)"
else
  bad "policy missing the failed-stale threshold"
fi

if grep -q 'conditionPrometheusQueryLanguage' "$POLICY" \
  && grep -q 'absent(' "$POLICY" \
  && grep -q 'disableMetricValidation: true' "$POLICY"; then
  pass "policy uses PromQL absent so a series that never existed still fires"
else
  bad "policy missing PromQL absent for a job that has never executed"
fi

if grep -q 'conditionAbsent' "$POLICY"; then
  bad "policy still uses conditionAbsent, which does not fire when the series never existed"
else
  pass "policy does not use conditionAbsent for the never-run case"
fi

if grep -q 'object' "$POLICY" && grep -q 'updated' "$POLICY"; then
  pass "policy docs name the object updated time as the age source"
else
  bad "policy docs do not name the object updated time"
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'watcher-silent-alert checks: passed\n'
