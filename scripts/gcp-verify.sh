#!/usr/bin/env bash
# Assert every claim in docs/GCP_SETUP.md against the live project.
#
# This exists because that document was written after the setup rather than
# before it, so it is a description of what someone believes was done. This
# script is the part that can be checked. It reads and asserts; it creates
# nothing, changes nothing and deletes nothing, so it is safe to run at any
# time and by anyone with read access.
#
#   scripts/gcp-verify.sh
#
# Exits non-zero on the first claim that does not hold, naming the claim, what
# was expected and what was actually found.
set -uo pipefail

PROJECT="veto-watcher-260921"
NUMBER="472736420070"
BILLING="01778E-30EA11-E3BA6D"
BUDGET="914d5c6c-9361-437b-8ea6-dd7b50ab333d"

# The budget API resolves its quota against the active project, which is not
# necessarily this one, so it is pinned for the calls that need it.
export CLOUDSDK_CORE_PROJECT="$PROJECT"

pass=0; fail=0
check() { # check <claim> <expected> <actual>
    if [ "$2" = "$3" ]; then
        printf '  ok   %s\n' "$1"; pass=$((pass+1))
    else
        printf '  FAIL %s\n         expected: [%s]\n         actual:   [%s]\n' "$1" "$2" "$3"
        fail=$((fail+1))
    fi
}
contains() { # contains <claim> <needle> <haystack>
    case "$3" in
        *"$2"*) printf '  ok   %s\n' "$1"; pass=$((pass+1)) ;;
        *) printf '  FAIL %s\n         missing: [%s]\n         in:      [%s]\n' "$1" "$2" "$3"; fail=$((fail+1)) ;;
    esac
}

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
gcloud auth list --filter=status:ACTIVE --format="value(account)" >/dev/null 2>&1 \
  || { echo "not authenticated: run gcloud auth login" >&2; exit 1; }

echo "Verifying docs/GCP_SETUP.md against the live project"
echo

echo "Project"
desc=$(gcloud projects describe "$PROJECT" --format="value(projectId,projectNumber,lifecycleState)" 2>/dev/null)
check "project exists, is active, and has the documented number" \
      "$PROJECT	$NUMBER	ACTIVE" "$desc"

labels=$(gcloud projects describe "$PROJECT" --format="value(labels)" 2>/dev/null)
for l in "environment=development" "owner=arlen" "purpose=veto-watcher"; do
    contains "label $l" "$l" "$labels"
done

echo
echo "Billing"
bill=$(gcloud billing projects describe "$PROJECT" --format="value(billingEnabled,billingAccountName)" 2>/dev/null)
check "billing is enabled and points at the documented account" \
      "True	billingAccounts/$BILLING" "$bill"

echo
echo "Budget"
bj=$(gcloud billing budgets describe "$BUDGET" --billing-account="$BILLING" --format=json 2>/dev/null)
if [ -z "$bj" ]; then
    printf '  FAIL budget %s could not be read\n' "$BUDGET"; fail=$((fail+1))
else
    check "budget amount is 200 SEK" "200 SEK" \
          "$(printf '%s' "$bj" | python3 -c 'import json,sys; a=json.load(sys.stdin)["amount"]["specifiedAmount"]; print(a["units"], a["currencyCode"])')"
    # A budget with no project filter covers the whole billing account, which
    # would fire on unrelated spend and protects this project from nothing.
    check "budget is scoped to this project alone" "['projects/$NUMBER']" \
          "$(printf '%s' "$bj" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("budgetFilter",{}).get("projects"))')"
    check "budget alerts at 50, 90 and 100 percent" "[0.5, 0.9, 1.0]" \
          "$(printf '%s' "$bj" | python3 -c 'import json,sys; print(sorted(r["thresholdPercent"] for r in json.load(sys.stdin).get("thresholdRules",[])))')"
fi

echo
echo "APIs"
enabled=$(gcloud services list --enabled --project="$PROJECT" --format="value(config.name)" 2>/dev/null)
for api in run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
           artifactregistry.googleapis.com cloudbuild.googleapis.com storage-api.googleapis.com \
           monitoring.googleapis.com billingbudgets.googleapis.com; do
    contains "$api enabled" "$api" "$enabled"
done

echo
echo "Claims the document makes about what is NOT here yet"
# These are asserted too. If one of them starts existing without the document
# being updated, the document has drifted and the reviewer should know.
# The default compute account is created by GCP itself when the APIs are
# enabled, so it is expected. Any second account means the deployment has begun
# and the document above is out of date.
sa=$(gcloud iam service-accounts list --project="$PROJECT" --format="value(email)" 2>/dev/null | grep -v "^$" | grep -vc "^$NUMBER-compute@developer.gserviceaccount.com$" | tr -d ' ')
check "no service account beyond the one GCP created by itself" "0" "$sa"

# Historically this account carried Editor. If it ever does here, a job that
# picks it up by default can do anything in the project.
compute_roles=$(gcloud projects get-iam-policy "$PROJECT" --flatten="bindings[].members" \
  --filter="bindings.members:$NUMBER-compute@developer.gserviceaccount.com" \
  --format="value(bindings.role)" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')
check "the default compute account holds no project role" "" "$compute_roles"
buckets=$(gcloud storage buckets list --project="$PROJECT" --format="value(name)" 2>/dev/null | grep -v "^$" | wc -l | tr -d ' ')
check "no bucket has been created yet" "0" "$buckets"
secrets=$(gcloud secrets list --project="$PROJECT" --format="value(name)" 2>/dev/null | grep -v "^$" | wc -l | tr -d ' ')
check "no secret has been created yet" "0" "$secrets"
jobs=$(gcloud run jobs list --project="$PROJECT" --format="value(metadata.name)" 2>/dev/null | grep -v "^$" | wc -l | tr -d ' ')
check "no Cloud Run job has been created yet" "0" "$jobs"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
