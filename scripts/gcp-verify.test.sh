#!/usr/bin/env bash
# Critic fixtures for scripts/gcp-verify.sh (round 2 absences, round 3
# budget-name re-point and table contract).
#
# No live GCP, no credentials, no network. A fake gcloud on PATH is the
# only cloud the script is allowed to see. These checks encode the
# document's own contract (docs/GCP_SETUP.md) and the fail-closed rule
# for absence assertions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="${ROOT}/scripts/gcp-verify.sh"
DOC="${ROOT}/docs/GCP_SETUP.md"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -f "$VERIFY" ]] || { echo "missing $VERIFY"; exit 1; }
[[ -f "$DOC" ]] || { echo "missing $DOC"; exit 1; }
[[ -x "$VERIFY" ]] || { echo "$VERIFY is not executable"; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/gcp-verify.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
LOG="${WORKDIR}/gcloud.log"
FAKE="${WORKDIR}/gcloud"
OUT="${WORKDIR}/verify.out"

# Fake gcloud. Modes:
#   lists-fail: authenticated, every describe/list fails empty
#   happy: project/billing/budget/API/identity calls succeed; scheduler,
#          Artifact Registry and Cloud Run services return resources if asked
#   happy-nanos: happy budget of 200 SEK plus 500000000 nanos
#   happy-mute: happy thresholds, default IAM recipients disabled, no channels
#   happy-wide-labels: two labels widened, purpose=veto-watcher left exact
cat >"$FAKE" <<'FAKE'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "${FAKE_GCLOUD_LOG}"
args="$*"
mode="${FAKE_GCLOUD_MODE}"

if [[ "$args" == *'auth list'* ]]; then
    printf '%s\n' 'fake@example.com'
    exit 0
fi

happy_budget() {
    local nanos="${1:-0}"
    local mute="${2:-0}"
    local units='"units": "200"'
    if [[ "$nanos" != 0 ]]; then
        units='"units": "200", "nanos": 500000000'
    fi
    local notify='{}'
    if [[ "$mute" == 1 ]]; then
        notify='{"disableDefaultIamRecipients": true, "monitoringNotificationChannels": []}'
    fi
    printf '{"displayName":"veto-watcher spend alert (does not stop spend)","amount":{"specifiedAmount":{%s,"currencyCode":"SEK"}},"budgetFilter":{"projects":["projects/472736420070"]},"thresholdRules":[{"thresholdPercent":0.5},{"thresholdPercent":0.9},{"thresholdPercent":1.0}],"notificationsRule":%s}\n' "$units" "$notify"
}

if [[ "$mode" == lists-fail ]]; then
    exit 1
fi

if [[ "$args" == *'projectId,projectNumber,name,lifecycleState,createTime'* ]]; then
    printf 'veto-watcher-260921\t472736420070\tVeto Watcher\tACTIVE\t2026-09-21T11:36:55.000Z\n'
    exit 0
fi
if [[ "$args" == *'value(labels)'* || "$args" == *'format=value(labels)'* || "$args" == *'--format=value(labels)'* ]]; then
    if [[ "$mode" == happy-wide-labels ]]; then
        printf 'environment=development-staging;owner=arlenx;purpose=veto-watcher\n'
    else
        printf 'environment=development;owner=arlen;purpose=veto-watcher\n'
    fi
    exit 0
fi
if [[ "$args" == *'billing projects describe'* ]]; then
    printf 'True\tbillingAccounts/01778E-30EA11-E3BA6D\n'
    exit 0
fi
if [[ "$args" == *'billing budgets describe'* ]]; then
    case "$mode" in
        happy-nanos) happy_budget 1 0 ;;
        happy-mute) happy_budget 0 1 ;;
        *) happy_budget 0 0 ;;
    esac
    exit 0
fi
# `run services list` contains the substring `services list`. Match the
# Cloud Run call first or the API list is returned as if it were a service.
if [[ "$args" == *'run services list'* ]]; then
    printf '%s\n' 'accidentally-public'
    exit 0
fi
if [[ "$args" == *'services list'* ]]; then
    printf '%s\n' \
        run.googleapis.com \
        cloudscheduler.googleapis.com \
        secretmanager.googleapis.com \
        artifactregistry.googleapis.com \
        cloudbuild.googleapis.com \
        storage-api.googleapis.com \
        storage.googleapis.com \
        monitoring.googleapis.com \
        billingbudgets.googleapis.com
    exit 0
fi
if [[ "$args" == *'service-accounts list'* ]]; then
    printf '%s\n' '472736420070-compute@developer.gserviceaccount.com'
    exit 0
fi
if [[ "$args" == *'get-iam-policy'* ]]; then
    exit 0
fi
if [[ "$args" == *'get-ancestors'* ]]; then
    printf '%s\n' $'472736420070\tproject' $'example.org\torganization'
    exit 0
fi
if [[ "$args" == *'storage buckets list'* ]]; then
    exit 0
fi
if [[ "$args" == *'secrets list'* ]]; then
    exit 0
fi
if [[ "$args" == *'run jobs list'* ]]; then
    exit 0
fi
if [[ "$args" == *'scheduler jobs list'* ]]; then
    printf '%s\n' 'veto-watcher-tick'
    exit 0
fi
if [[ "$args" == *'artifacts repositories list'* ]]; then
    printf '%s\n' 'veto'
    exit 0
fi
exit 1
FAKE
chmod +x "$FAKE"

run_verify() {
    local mode="$1"
    : >"$LOG"
    : >"$OUT"
    FAKE_GCLOUD_MODE="$mode" FAKE_GCLOUD_LOG="$LOG" \
        PATH="${WORKDIR}:${PATH}" \
        "$VERIFY" >"$OUT" 2>&1 || true
}

# ----------------------------------------------------------------------
# F1. Absence checks fail open when gcloud list/describe returns nothing.
# ----------------------------------------------------------------------
run_verify lists-fail
for claim in \
    "no bucket yet" \
    "no secret yet" \
    "no Cloud Run job yet" \
    "no Cloud Run service yet" \
    "no Cloud Scheduler job yet" \
    "no Artifact Registry repo yet" \
    "no service account beyond the one GCP created by itself" \
    "the default compute account holds no project role"
do
    if grep -F -q "  ok   ${claim}" "$OUT"; then
        bad "absence '${claim}' reports ok when gcloud failed (scripts/gcp-verify.sh absences)"
    else
        pass "absence '${claim}' does not report ok on gcloud failure"
    fi
done
ok_lines="$(grep -c '^  ok' "$OUT" || true)"
if [[ "$ok_lines" -eq 0 ]]; then
    pass "lists-fail prints zero ok lines"
else
    bad "lists-fail printed ${ok_lines} ok lines (fail-open regression)"
fi

# ----------------------------------------------------------------------
# F2. docs/GCP_SETUP.md:49 names no Artifact Registry repository, no
# scheduler, and no job. Round 1 grepped a retired claim string
# (`no Cloud Run job has been created yet`). The rewrite prints
# `no Cloud Run job yet`, continues after get-ancestors, and lists
# scheduler / Artifact Registry / Cloud Run services. The happy fake
# returns resources for those three if asked.
# ----------------------------------------------------------------------
run_verify happy
if grep -F -q "  ok   no Cloud Run job yet" "$OUT"; then
    if grep -q 'scheduler jobs list' "$LOG"; then
        pass "script listed scheduler jobs"
    else
        bad "docs/GCP_SETUP.md:49 claims no scheduler; scripts/gcp-verify.sh never ran gcloud scheduler jobs list"
    fi
    if grep -q 'artifacts repositories list' "$LOG"; then
        pass "script listed Artifact Registry repositories"
    else
        bad "docs/GCP_SETUP.md:49 claims no Artifact Registry repository; scripts/gcp-verify.sh never ran gcloud artifacts repositories list"
    fi
    if grep -q 'run services list' "$LOG"; then
        pass "script listed Cloud Run services"
    else
        bad "docs/GCP_SETUP.md:49 claims no job; scripts/gcp-verify.sh never ran gcloud run services list"
    fi
    if grep -F -q "  FAIL no Cloud Run service yet" "$OUT" \
        && grep -F -q "  FAIL no Cloud Scheduler job yet" "$OUT" \
        && grep -F -q "  FAIL no Artifact Registry repo yet" "$OUT"; then
        pass "happy fake resources fail the matching absence claims"
    else
        bad "happy fake returned a service, scheduler job and registry repo; those absences did not FAIL"
    fi
else
    bad "happy fake did not reach the absence checks (see ${OUT})"
fi

# ----------------------------------------------------------------------
# F3. Budget notifications pass with default IAM recipients disabled
# and no channels. docs/GCP_SETUP.md:70 says the budget alerts by
# email to the billing account administrators.
# ----------------------------------------------------------------------
run_verify happy-mute
if grep -F -q "  ok   budget notifications actually reach someone" "$OUT"; then
    bad "docs/GCP_SETUP.md:70 email-alert claim: scripts/gcp-verify.sh passed notifications with disableDefaultIamRecipients and no channels"
else
    pass "budget notifications do not pass on a muted notificationsRule"
fi

# ----------------------------------------------------------------------
# F4. 200 SEK plus 500000000 nanos still prints as 200 SEK.
# ----------------------------------------------------------------------
run_verify happy-nanos
if grep -F -q "  ok   budget amount is exactly 200 SEK, nanos included" "$OUT"; then
    bad "scripts/gcp-verify.sh treats units and ignores nanos (200 SEK + 500000000 nanos passed)"
else
    pass "budget amount does not ignore nanos"
fi

# ----------------------------------------------------------------------
# F5. Label membership is exact. The fake widens environment and owner
# and leaves purpose=veto-watcher correct. Only the widened labels are
# required to fail; accepting the exact one is the right behaviour.
# ----------------------------------------------------------------------
run_verify happy-wide-labels
wide_fail=0
for l in "environment=development" "owner=arlen"; do
    if grep -F -q "  ok   label ${l}" "$OUT"; then
        wide_fail=1
    fi
done
if [[ "$wide_fail" -eq 1 ]]; then
    bad "scripts/gcp-verify.sh member() passed environment=development-staging or owner=arlenx as the documented labels"
else
    pass "widened labels environment=development-staging and owner=arlenx do not pass"
fi
if grep -F -q "  ok   label purpose=veto-watcher" "$OUT"; then
    pass "exact remaining label purpose=veto-watcher is accepted"
else
    bad "exact remaining label purpose=veto-watcher was rejected"
fi

# ----------------------------------------------------------------------
# F6. First-fail is claimed and is false unless the producer drops the claim.
# ----------------------------------------------------------------------
run_verify lists-fail
fail_lines="$(grep -c '^  FAIL' "$OUT" || true)"
header_claims_first=0
doc_claims_first=0
grep -q 'Exits non-zero on the first claim that does not hold' "$VERIFY" && header_claims_first=1
grep -q 'exits non-zero on the first one that does not hold' "$DOC" && doc_claims_first=1
if [[ "$fail_lines" -gt 1 && ( "$header_claims_first" -eq 1 || "$doc_claims_first" -eq 1 ) ]]; then
    bad "docs/GCP_SETUP.md:87 and scripts/gcp-verify.sh:12 claim first-fail; printed ${fail_lines} FAIL lines"
else
    pass "first-fail claim matches behaviour"
fi

# ----------------------------------------------------------------------
# F7. Table claims the document says the script asserts (docs/GCP_SETUP.md:86
# and :3) that are absent from the script. Drop those sentences, or assert
# the fields.
# ----------------------------------------------------------------------
if grep -q 'asserts every claim in the table above' "$DOC" || grep -q 'every claim below is asserted by that script' "$DOC"; then
    table_missing=0
    grep -q 'Veto Watcher' "$VERIFY" || { bad "docs/GCP_SETUP.md:16 display name Veto Watcher is not asserted"; table_missing=1; }
    grep -q '2026-09-21T11:36:55Z' "$VERIFY" || { bad "docs/GCP_SETUP.md:17 created timestamp is not asserted"; table_missing=1; }
    grep -F -q 'veto-watcher spend alert (does not stop spend)' "$VERIFY" || { bad "docs/GCP_SETUP.md:20 budget name is not asserted"; table_missing=1; }
    grep -F -q 'DATA_READ' "$VERIFY" || { bad "docs/GCP_SETUP.md:21 Secret Manager DATA_READ is not asserted"; table_missing=1; }
    grep -F -q 'DATA_WRITE' "$VERIFY" || { bad "docs/GCP_SETUP.md:21 Secret Manager DATA_WRITE is not asserted"; table_missing=1; }
    if grep -q 'storage-api.googleapis.com' "$VERIFY" && ! grep -q 'storage.googleapis.com' "$VERIFY"; then
        bad "docs/GCP_SETUP.md:21 says storage; scripts/gcp-verify.sh:84 asserts storage-api.googleapis.com"
        table_missing=1
    fi
    if [[ "$table_missing" -eq 0 ]]; then
        pass "every table claim has a matching assertion"
    fi
else
    pass "document no longer claims the script asserts every table field"
fi

# ----------------------------------------------------------------------
# F8. Charter / roles/devops.md: set -euo pipefail.
# ----------------------------------------------------------------------
if grep -q '^set -euo pipefail$' "$VERIFY"; then
    pass "scripts/gcp-verify.sh uses set -euo pipefail"
else
    bad "scripts/gcp-verify.sh:14 is set -uo pipefail (missing -e; devops.md error handling)"
fi

if [[ "$fail" -ne 0 ]]; then
    echo
    echo "gcp-verify critic fixtures: FAILED"
    exit 1
fi
printf 'gcp-verify critic fixtures: passed\n'
