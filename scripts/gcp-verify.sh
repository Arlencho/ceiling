#!/usr/bin/env bash
# Assert every claim in docs/GCP_SETUP.md against the live project.
#
# That document was written after the setup rather than before it, so it is a
# description of what someone believes was done. This is the part that can be
# checked. It reads and asserts; it creates nothing, changes nothing and
# deletes nothing, so it is safe to run at any time by anyone with read access.
#
#   scripts/gcp-verify.sh
#
# Every check is run and every failure is printed, so one broken claim does not
# hide the next. The exit code is non-zero if any check failed.
#
# THE RULE THIS SCRIPT EXISTS TO ENFORCE ON ITSELF: a check may not pass
# because it could not look. The first version of this file counted resources
# with `gcloud ... 2>/dev/null | wc -l` and compared the count to zero, so a
# gcloud that failed for any reason at all, no permission, wrong project, no
# network, produced an empty list, a count of zero, and a green tick. It would
# have reported a clean project while being unable to see it. Every call now
# goes through `capture`, which fails the check when the command fails and
# never lets silence read as evidence.
set -euo pipefail

PROJECT="veto-watcher-260921"
NUMBER="472736420070"
BILLING="01778E-30EA11-E3BA6D"
BUDGET="914d5c6c-9361-437b-8ea6-dd7b50ab333d"
DISPLAY_NAME="Veto Watcher"
CREATED="2026-09-21T11:36:55Z"
BUDGET_NAME="veto-watcher spend alert (does not stop spend)"
# The billing account currency decides what a budget amount means, and the
# document states it, so it is asserted rather than assumed.
BILLING_CURRENCY="SEK"
DEFAULT_SA="$NUMBER-compute@developer.gserviceaccount.com"
# Cloud Run runs in europe-north1. Cloud Scheduler does not exist there at all,
# so the schedule lives in the nearest region that serves it. The cadence is in
# Europe/Stockholm either way, which is what actually matters for the prices.
RUN_REGION="europe-north1"
SCHEDULER_REGION="europe-west1"

# The budget API resolves its quota against the active project, which is not
# necessarily this one.
export CLOUDSDK_CORE_PROJECT="$PROJECT"

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); return 0; }
bad()  { printf '  FAIL %s\n' "$1"; shift; for l in "$@"; do printf '         %s\n' "$l"; done; fail=$((fail+1)); return 0; }

# capture <var> <claim> <command...>
# Runs the command. On failure, fails the claim and returns 1, so the caller
# skips its assertion rather than asserting on an empty string.
capture() {
    local __var="$1" __claim="$2"; shift 2
    local __out __err __rc=0 __ef
    __ef=$(mktemp)
    # Under set -e a failing command substitution aborts the shell before the
    # next line runs, so the exit status has to be taken in the same statement.
    __out=$("$@" 2>"$__ef") || __rc=$?
    __err=$(head -1 "$__ef" 2>/dev/null || true); rm -f "$__ef"
    if [ $__rc -ne 0 ]; then
        bad "$__claim" "could not look: $* exited $__rc" "$__err"
        return 1
    fi
    printf -v "$__var" '%s' "$__out"
    return 0
}

equal()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected: [$2]" "actual:   [$3]"; fi; }
# Exact membership in a newline or semicolon separated list, not a substring:
# a substring test passes environment=development-staging for environment=development.
member() { # member <claim> <needle> <haystack>
    local IFS=$'\n;'
    for item in $3; do
        if [ "$item" = "$2" ]; then ok "$1"; return 0; fi
    done
    bad "$1" "no exact match for: [$2]" "in: [$3]"
    return 0
}

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }
acct=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null)
[ -n "$acct" ] || { echo "not authenticated: run gcloud auth login" >&2; exit 2; }

echo "Verifying docs/GCP_SETUP.md against the live project"
echo "  as: $acct"
echo

echo "Project"
if capture d "project exists with the documented id, number, name, state and creation time" \
        gcloud projects describe "$PROJECT" --format=value'(projectId,projectNumber,name,lifecycleState,createTime)'; then
    IFS=$'\t' read -r pid pnum pname pstate pcreated <<<"$d"
    equal "project id and number" "$PROJECT $NUMBER" "$pid $pnum"
    equal "project display name" "$DISPLAY_NAME" "$pname"
    equal "project is active" "ACTIVE" "$pstate"
    # createTime carries sub-second precision; compare to the second.
    equal "project creation time" "${CREATED%Z}" "$(printf '%s' "$pcreated" | cut -c1-19)"
fi

if capture labels "project labels" gcloud projects describe "$PROJECT" --format=value'(labels)'; then
    for l in "environment=development" "owner=arlen" "purpose=veto-watcher"; do
        member "label $l" "$l" "$labels"
    done
fi

echo
echo "Billing"
if capture b "billing is enabled and points at the documented account" \
        gcloud billing projects describe "$PROJECT" --format=value'(billingEnabled,billingAccountName)'; then
    equal "billing enabled and account" "True	billingAccounts/$BILLING" "$b"
fi

if capture cur "billing account currency can be read" \
        gcloud billing accounts describe "$BILLING" --format=value'(currencyCode)'; then
    equal "billing account currency" "$BILLING_CURRENCY" "$cur"
fi

echo
echo "Budget"
if capture bj "budget $BUDGET can be read" \
        gcloud billing budgets describe "$BUDGET" --billing-account="$BILLING" --format=json; then
    parse() { printf '%s' "$bj" | python3 -c "$1" 2>/dev/null; }
    equal "budget display name" "$BUDGET_NAME" \
          "$(parse 'import json,sys; print(json.load(sys.stdin).get("displayName",""))')"
    # nanos are a real part of the amount: 200 units plus 500000000 nanos is
    # 200.5, and checking units alone calls that 200.
    equal "budget amount is exactly 200 SEK, nanos included" "200 0 SEK" \
          "$(parse 'import json,sys; a=json.load(sys.stdin)["amount"]["specifiedAmount"]; print(a.get("units","0"), a.get("nanos",0), a.get("currencyCode",""))')"
    # A budget with no project filter covers the whole billing account: it
    # fires on unrelated spend and protects this project from nothing.
    equal "budget is scoped to this project alone" "['projects/$NUMBER']" \
          "$(parse 'import json,sys; print(json.load(sys.stdin).get("budgetFilter",{}).get("projects"))')"
    equal "budget thresholds are 50, 90 and 100 percent" "[0.5, 0.9, 1.0]" \
          "$(parse 'import json,sys; print(sorted(r["thresholdPercent"] for r in json.load(sys.stdin).get("thresholdRules",[])))')"
    # Thresholds with nowhere to go are decoration. Either the billing admins
    # get the mail, or a channel is named.
    equal "budget notifications actually reach someone" "reaches-someone" \
          "$(parse 'import json,sys
d=json.load(sys.stdin).get("notificationsRule",{}) or {}
muted=d.get("disableDefaultIamRecipients", False)
chans=d.get("monitoringNotificationChannels") or []
print("reaches-someone" if (not muted) or chans else "nobody-is-notified")')"
fi

echo
echo "APIs"
if capture enabled "enabled services can be listed" \
        gcloud services list --enabled --project="$PROJECT" --format=value'(config.name)'; then
    for api in run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
               artifactregistry.googleapis.com cloudbuild.googleapis.com storage-api.googleapis.com \
               monitoring.googleapis.com billingbudgets.googleapis.com \
               storage.googleapis.com; do
        member "$api enabled" "$api" "$enabled"
    done
fi

echo
echo "Identity: who can act, and who could read the key once it exists"
if capture sas "service accounts can be listed" \
        gcloud iam service-accounts list --project="$PROJECT" --format=value'(email)'; then
    extra=$(printf '%s\n' "$sas" | grep -v '^[[:space:]]*$' | grep -vx "$DEFAULT_SA" || true)
    equal "no service account beyond the one GCP created by itself" "" "$extra"
fi

# The default compute account is what a Cloud Run job picks up when nobody
# tells it otherwise. If it ever gains a role, that is what the job runs as.
if capture roles "the default compute account's project roles can be listed" \
        gcloud projects get-iam-policy "$PROJECT" --flatten=bindings'[].members' \
          --filter="bindings.members:$DEFAULT_SA" --format=value'(bindings.role)'; then
    equal "the default compute account holds no project LEVEL role binding" "" "$(printf '%s' "$roles" | tr -d '[:space:]')"
fi

# A project level policy says nothing about inheritance. Someone with Editor at
# the organisation can read every secret here and appears in no binding above.
if capture anc "the project's ancestry can be read" \
        gcloud projects get-ancestors "$PROJECT" --format=value'(id,type)'; then
    printf '  note the check above covers project level bindings ONLY. Access inherited from\n'
    printf '       the org or a folder does not appear in a project policy and is NOT checked\n'
    printf '       here. Anyone with Owner or Editor at the levels below can read every secret\n'
    printf '       in this project:\n'
    printf '%s\n' "$anc" | sed 's/^/         /'
fi

echo
echo "Claims the document makes about what is NOT here yet"
# Asserted so that a resource appearing without the document being updated is a
# failure rather than silent drift.
absent() { # absent <claim> <command...>
    local claim="$1"; shift
    local out
    if capture out "$claim" "$@"; then
        equal "$claim" "" "$(printf '%s' "$out" | grep -v '^[[:space:]]*$' || true)"
    fi
}
absent "no bucket yet"                gcloud storage buckets list --project="$PROJECT" --format=value'(name)'
absent "no secret yet"                gcloud secrets list --project="$PROJECT" --format=value'(name)'
absent "no Cloud Run job yet"         gcloud run jobs list --project="$PROJECT" --format=value'(metadata.name)'
absent "no Cloud Run service yet"     gcloud run services list --project="$PROJECT" --format=value'(metadata.name)'
absent "no Cloud Scheduler job yet"   gcloud scheduler jobs list --project="$PROJECT" --location="$SCHEDULER_REGION" --format=value'(name)'
absent "no Artifact Registry repo yet" gcloud artifacts repositories list --project="$PROJECT" --format=value'(name)'

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
