#!/usr/bin/env bash
# Prove scripts/gcp-verify.sh lists every principal that can read a secret
# version, names where that access comes from, and states that it cannot
# see bindings above the project. A short list is not a complete list.
#
# No live GCP, no credentials, no network. A fake gcloud on PATH is the
# only cloud the script is allowed to see.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="${ROOT}/scripts/gcp-verify.sh"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -x "$VERIFY" ]] || { echo "missing executable $VERIFY"; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/gcp-verify-secrets.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
LOG="${WORKDIR}/gcloud.log"
FAKE="${WORKDIR}/gcloud"
OUT="${WORKDIR}/verify.out"

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

if [[ "$mode" == lists-fail ]]; then
    exit 1
fi

if [[ "$args" == *'projectId,projectNumber,name,lifecycleState,createTime'* ]]; then
    printf 'veto-watcher-260921\t472736420070\tVeto Watcher\tACTIVE\t2026-09-21T11:36:55.000Z\n'
    exit 0
fi
if [[ "$args" == *'value(labels)'* || "$args" == *'format=value(labels)'* || "$args" == *'--format=value(labels)'* ]]; then
    printf 'environment=development;owner=arlen;purpose=veto-watcher\n'
    exit 0
fi
if [[ "$args" == *'billing accounts describe'* ]]; then
    printf 'SEK\n'
    exit 0
fi
if [[ "$args" == *'billing projects describe'* ]]; then
    printf 'True\tbillingAccounts/01778E-30EA11-E3BA6D\n'
    exit 0
fi
if [[ "$args" == *'billing budgets describe'* ]]; then
    printf '{"displayName":"veto-watcher spend alert (does not stop spend)","amount":{"specifiedAmount":{"units": "200","currencyCode":"SEK"}},"budgetFilter":{"projects":["projects/472736420070"]},"thresholdRules":[{"thresholdPercent":0.5},{"thresholdPercent":0.9},{"thresholdPercent":1.0}],"notificationsRule":{}}\n'
    exit 0
fi
if [[ "$args" == *'run services list'* ]]; then
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
if [[ "$args" == *'organizations get-iam-policy'* ]]; then
    printf 'PERMISSION_DENIED: caller does not have organizations.getIamPolicy\n' >&2
    exit 1
fi
if [[ "$args" == *'folders get-iam-policy'* ]]; then
    printf 'PERMISSION_DENIED: caller does not have folders.getIamPolicy\n' >&2
    exit 1
fi
if [[ "$args" == *'secrets get-iam-policy'* ]]; then
    printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:veto-watcher@veto-watcher-260921.iam.gserviceaccount.com"]}]}\n'
    exit 0
fi
if [[ "$args" == *'projects get-iam-policy'* ]]; then
    if [[ "$args" == *'format=json'* ]]; then
        printf '{"bindings":[{"role":"roles/owner","members":["user:owner@example.com"]},{"role":"roles/editor","members":["serviceAccount:472736420070-compute@developer.gserviceaccount.com"]}]}\n'
        exit 0
    fi
    exit 0
fi
if [[ "$args" == *'get-iam-policy'* ]]; then
    printf '{"bindings":[]}\n'
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
    printf '%s\n' 'veto-agent-keypair'
    exit 0
fi
if [[ "$args" == *'run jobs list'* ]]; then
    exit 0
fi
if [[ "$args" == *'scheduler jobs list'* ]]; then
    exit 0
fi
if [[ "$args" == *'artifacts repositories list'* ]]; then
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

run_verify listing
if grep -F -q 'principal user:owner@example.com  role roles/owner  from project policy' "$OUT"; then
    pass "lists the project Owner and names the project policy as the source"
else
    bad "expected Owner from project policy in listing (see ${OUT})"
fi
if grep -F -q 'principal serviceAccount:veto-watcher@veto-watcher-260921.iam.gserviceaccount.com  role roles/secretmanager.secretAccessor  from secret veto-agent-keypair policy' "$OUT"; then
    pass "lists the job account on the secret and names the secret policy as the source"
else
    bad "expected secretAccessor from secret policy in listing (see ${OUT})"
fi
if grep -F -q 'principal serviceAccount:472736420070-compute@developer.gserviceaccount.com' "$OUT"; then
    bad "Editor on the default compute account must not be listed as secret version access"
else
    pass "Editor on the default compute account is not listed as secret version access"
fi
if grep -q 'cannot see IAM bindings above the project' "$OUT" \
    && grep -q 'short list is not a complete' "$OUT"; then
    pass "principal listing states it cannot see bindings above the project"
else
    bad "principal listing omitted its blind spot (see ${OUT})"
fi
if grep -q 'Organization or folder get-iam-policy did not succeed' "$OUT"; then
    pass "listing names the failed organization policy read rather than omitting it"
else
    bad "listing did not say the organization policy was unreadable (see ${OUT})"
fi
if grep -q 'organizations get-iam-policy' "$LOG"; then
    pass "listing attempted the organization policy"
else
    bad "listing never called organizations get-iam-policy"
fi

run_verify lists-fail
if grep -F -q '  ok   project IAM policy was parsed for secretmanager.versions.access' "$OUT"; then
    bad "listing reported a parsed project policy when gcloud failed"
else
    pass "listing does not report a parsed project policy when gcloud failed"
fi
if grep -F -q '  ok   the default compute account is absent from readable policies that grant secretmanager.versions.access' "$OUT"; then
    bad "default compute absence passed because the policy could not be read"
else
    pass "default compute absence does not pass because the policy could not be read"
fi
if grep -q 'cannot see IAM bindings above the project' "$OUT"; then
    pass "lists-fail still states the listing cannot see bindings above the project"
else
    bad "lists-fail omitted the above-project blind spot (see ${OUT})"
fi
if grep -q '^  principal ' "$OUT"; then
    bad "lists-fail printed principals after gcloud failed"
else
    pass "lists-fail prints no principal lines"
fi

if [[ "$fail" -ne 0 ]]; then
    echo
    echo "gcp-verify secret-access listing: FAILED"
    exit 1
fi
printf 'gcp-verify secret-access listing: passed\n'
