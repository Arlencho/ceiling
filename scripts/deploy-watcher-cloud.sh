#!/usr/bin/env bash
# Create or update the Cloud Run watcher job. Idempotent. Refuses before
# creating anything if a required input is missing. Never prints a secret.
#
# The owner runs this. It does not run from CI and it does not execute the
# job. See watcher/CLOUD.md.
#
#   ./scripts/deploy-watcher-cloud.sh --check
#   ./scripts/deploy-watcher-cloud.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT="${PROJECT:-veto-watcher-260921}"
REGION="${REGION:-europe-north1}"
# Cloud Scheduler is not offered in europe-north1 (Finland). Belgium is the
# nearest Scheduler region; the job it invokes still runs in europe-north1.
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-europe-west1}"
JOB_NAME="${JOB_NAME:-veto-watcher}"
STALE_JOB_NAME="${STALE_JOB_NAME:-veto-watcher-stale}"
SCHEDULER_JOB="${SCHEDULER_JOB:-veto-watcher-cadence}"
STALE_SCHEDULER_JOB="${STALE_SCHEDULER_JOB:-veto-watcher-stale-hourly}"
SA_NAME="${SA_NAME:-veto-watcher}"
AR_REPO="${AR_REPO:-veto-watcher}"
IMAGE_NAME="${IMAGE_NAME:-watcher}"
SECRET_NAME="${SECRET_NAME:-veto-agent-keypair}"
if [[ -z "${BUCKET+x}" ]]; then
  BUCKET="${PROJECT}-journal"
fi
JOURNAL_OBJECT="${JOURNAL_OBJECT:-decisions.jsonl}"
ALERT_POLICY_FILE="${ALERT_POLICY_FILE:-${ROOT}/infra/watcher-silent-alert.yaml}"
STALE_ALERT_POLICY_FILE="${STALE_ALERT_POLICY_FILE:-${ROOT}/infra/watcher-stale-alert.yaml}"
DOCKERFILE="${DOCKERFILE:-${ROOT}/watcher/Dockerfile}"

IDENTITY_VARS=(
  VETO_RPC
  VETO_PROGRAM_ID
  VETO_MINT
  VETO_OWNER
  VETO_OWNER_TOKEN
  VETO_MERCHANT
  VETO_MERCHANT_TOKEN
  VETO_AGENT
)

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Must not be `local` inside deploy: the EXIT trap runs after deploy returns,
# and a function-local is already gone. With set -u that exits 1 after
# printing deployed.
env_file=""
cleanup_env_file() {
  if [[ -n "${env_file:-}" ]]; then
    rm -f "$env_file"
    env_file=""
  fi
}
trap cleanup_env_file EXIT

usage() {
  cat <<'EOF'
usage: ./scripts/deploy-watcher-cloud.sh [--check] [--dry-run]

Creates the journal bucket, the agent key in Secret Manager, the image, the
Cloud Run jobs, the Cloud Scheduler entries, and the two silent-journal
alert policies (record too old, check stopped reporting).

Required environment:
  AGENT_KEY_PATH     path to the agent keypair JSON (never printed)
  VETO_RPC           Solana RPC URL
  VETO_PROGRAM_ID    program id
  VETO_MINT          mint
  VETO_OWNER         owner pubkey
  VETO_OWNER_TOKEN   owner token account
  VETO_MERCHANT      merchant pubkey
  VETO_MERCHANT_TOKEN merchant token account
  VETO_AGENT         agent pubkey

Optional environment:
  PROJECT            default veto-watcher-260921
  REGION             default europe-north1
  SCHEDULER_LOCATION default europe-west1 (Scheduler is not in europe-north1)
  BUCKET             default ${PROJECT}-journal
  ALERT_EMAIL        owner email for the silent-journal alert
  AGENT_KEY_PATH     required, no default
EOF
}

MODE="deploy"
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --dry-run) MODE="dry-run" ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: ${arg} (try --help)" ;;
  esac
done

run() {
  if [[ "$MODE" == "dry-run" ]]; then
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    die "missing ${name}; set it in the environment (see watcher/CLOUD.md)"
  fi
}

need_no_quote() {
  local name="$1"
  local value="${!name}"
  case "$value" in
    *\"*) die "${name} contains a double quote; refuse rather than break the env file" ;;
  esac
}

require_agent_key_file() {
  local path="${AGENT_KEY_PATH:-}"
  [[ -n "$path" ]] || die "missing AGENT_KEY_PATH; set it to the agent keypair JSON on this machine"
  [[ -f "$path" ]] || die "agent key file not found at AGENT_KEY_PATH"
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      process.stderr.write("agent key file is not a JSON keypair array\n");
      process.exit(1);
    }
    if (!Array.isArray(data) || data.length < 64) {
      process.stderr.write("agent key file is not a JSON keypair array\n");
      process.exit(1);
    }
  ' "$path" || die "agent key file is not a JSON keypair array"
}

require_local_inputs() {
  need_cmd node
  [[ -f "$DOCKERFILE" ]] || die "missing ${DOCKERFILE}"
  [[ -f "${ROOT}/watcher/package-lock.json" ]] || die "missing watcher/package-lock.json"
  [[ -f "$ALERT_POLICY_FILE" ]] || die "missing ${ALERT_POLICY_FILE}"
  [[ -f "$STALE_ALERT_POLICY_FILE" ]] || die "missing ${STALE_ALERT_POLICY_FILE}"
  [[ -n "$PROJECT" ]] || die "missing PROJECT"
  [[ -n "$REGION" ]] || die "missing REGION"
  [[ -n "$BUCKET" ]] || die "missing BUCKET; set BUCKET to the journal bucket name"
  [[ -n "$SECRET_NAME" ]] || die "missing SECRET_NAME"
  require_agent_key_file
  local name
  for name in "${IDENTITY_VARS[@]}"; do
    need_var "$name"
    need_no_quote "$name"
  done
  need_no_quote PROJECT
  need_no_quote REGION
  need_no_quote BUCKET
  if [[ -n "${VETO_PURPOSE:-}" ]]; then
    need_no_quote VETO_PURPOSE
  fi
}

require_gcloud() {
  need_cmd gcloud
  local account
  account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
  [[ -n "$account" ]] || die "gcloud is not logged in"
}

require_services() {
  local svc
  for svc in \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    secretmanager.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    storage.googleapis.com \
    monitoring.googleapis.com \
    logging.googleapis.com
  do
    if ! gcloud services list --enabled --project="$PROJECT" --filter="config.name:${svc}" --format='value(config.name)' | grep -qx "$svc"; then
      die "required API ${svc} is not enabled on ${PROJECT}"
    fi
  done
}

write_env_file() {
  local dest="$1"
  local purpose="${VETO_PURPOSE:-SE3 home charging}"
  cat > "$dest" <<EOF
VETO_RPC="${VETO_RPC}"
VETO_PROGRAM_ID="${VETO_PROGRAM_ID}"
VETO_MINT="${VETO_MINT}"
VETO_OWNER="${VETO_OWNER}"
VETO_OWNER_TOKEN="${VETO_OWNER_TOKEN}"
VETO_MERCHANT="${VETO_MERCHANT}"
VETO_MERCHANT_TOKEN="${VETO_MERCHANT_TOKEN}"
VETO_AGENT="${VETO_AGENT}"
VETO_KEYS_DIR="/keys"
VETO_JOURNAL="/tmp/veto/decisions.jsonl"
VETO_JOURNAL_GCS="gs://${BUCKET}/${JOURNAL_OBJECT}"
VETO_MANDATE_ID="${VETO_MANDATE_ID:-1}"
VETO_KWH_MILLI="${VETO_KWH_MILLI:-50000}"
VETO_MINT_DECIMALS="${VETO_MINT_DECIMALS:-6}"
VETO_PURPOSE="${purpose}"
EOF
}

ensure_sa() {
  local email="$1"
  if gcloud iam service-accounts describe "$email" --project="$PROJECT" >/dev/null 2>&1; then
    log "service account exists: ${email}"
    return 0
  fi
  run gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Veto watcher" \
    --project="$PROJECT"
}

ensure_bucket() {
  if gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT" >/dev/null 2>&1; then
    log "bucket exists: gs://${BUCKET}"
  else
    run gcloud storage buckets create "gs://${BUCKET}" \
      --location="$REGION" \
      --uniform-bucket-level-access \
      --project="$PROJECT"
  fi
  if gcloud storage objects describe "gs://${BUCKET}/${JOURNAL_OBJECT}" --project="$PROJECT" >/dev/null 2>&1; then
    log "journal object exists: gs://${BUCKET}/${JOURNAL_OBJECT}"
  else
    local empty
    empty="$(mktemp)"
    : > "$empty"
    run gcloud storage cp "$empty" "gs://${BUCKET}/${JOURNAL_OBJECT}" --project="$PROJECT"
    rm -f "$empty"
  fi
}

ensure_secret() {
  if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" >/dev/null 2>&1; then
    log "secret exists: ${SECRET_NAME} (adding a new version from AGENT_KEY_PATH)"
    run gcloud secrets versions add "$SECRET_NAME" \
      --data-file="${AGENT_KEY_PATH}" \
      --project="$PROJECT"
  else
    run gcloud secrets create "$SECRET_NAME" \
      --data-file="${AGENT_KEY_PATH}" \
      --replication-policy=automatic \
      --project="$PROJECT"
  fi
}

ensure_ar_repo() {
  if gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
    log "artifact registry repo exists: ${AR_REPO}"
    return 0
  fi
  run gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Veto watcher images" \
    --project="$PROJECT"
}

ensure_scheduler() {
  local name="$1"
  local schedule="$2"
  local uri="$3"
  local sa_email="$4"
  if gcloud scheduler jobs describe "$name" --location="$SCHEDULER_LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
    run gcloud scheduler jobs update http "$name" \
      --location="$SCHEDULER_LOCATION" \
      --schedule="$schedule" \
      --time-zone="Europe/Stockholm" \
      --uri="$uri" \
      --http-method=POST \
      --oauth-service-account-email="$sa_email" \
      --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
      --project="$PROJECT"
  else
    run gcloud scheduler jobs create http "$name" \
      --location="$SCHEDULER_LOCATION" \
      --schedule="$schedule" \
      --time-zone="Europe/Stockholm" \
      --uri="$uri" \
      --http-method=POST \
      --oauth-service-account-email="$sa_email" \
      --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
      --project="$PROJECT"
  fi
}

policy_name_by_display() {
  gcloud monitoring policies list \
    --project="$PROJECT" \
    --filter="displayName=\"${1}\"" \
    --format='value(name)' | head -n1 || true
}

# Merge a comma-separated channel list with an optional extra channel.
merge_channels() {
  local combined="${1:-}"
  local extra="${2:-}"
  if [[ -z "$extra" ]]; then
    printf '%s' "$combined"
    return 0
  fi
  case ",${combined}," in
    *",${extra},"*) printf '%s' "$combined" ;;
    *)
      if [[ -n "$combined" ]]; then
        printf '%s,%s' "$combined" "$extra"
      else
        printf '%s' "$extra"
      fi
      ;;
  esac
}

ensure_one_alert() {
  local display_name="$1"
  local policy_file="$2"
  local ch="${3:-}"
  local existing preserved="" combined
  existing="$(policy_name_by_display "$display_name")"
  if [[ -n "$existing" ]]; then
    log "alert policy exists: ${existing}"
    # Replacing a policy from file drops notification channels. Read them
    # first, then put them back on the same update.
    if [[ "$MODE" != "dry-run" ]]; then
      preserved="$(gcloud monitoring policies describe "$existing" \
        --project="$PROJECT" \
        --format='value[separator=","](notificationChannels)' 2>/dev/null || true)"
    fi
    combined="$(merge_channels "$preserved" "$ch")"
    if [[ -n "$combined" ]]; then
      run gcloud monitoring policies update "$existing" \
        --policy-from-file="$policy_file" \
        --set-notification-channels="$combined" \
        --project="$PROJECT"
    else
      run gcloud monitoring policies update "$existing" \
        --policy-from-file="$policy_file" \
        --project="$PROJECT"
    fi
    return 0
  fi
  if [[ -n "$ch" ]]; then
    run gcloud monitoring policies create \
      --policy-from-file="$policy_file" \
      --notification-channels="$ch" \
      --project="$PROJECT"
  else
    run gcloud monitoring policies create \
      --policy-from-file="$policy_file" \
      --project="$PROJECT"
  fi
}

ensure_alert() {
  local ch=""
  if [[ -n "${ALERT_EMAIL:-}" ]]; then
    ch="$(gcloud monitoring channels list --project="$PROJECT" --filter="labels.email_address=\"${ALERT_EMAIL}\" AND type=email" --format='value(name)' | head -n1 || true)"
    if [[ -z "$ch" ]]; then
      run gcloud monitoring channels create \
        --display-name="Veto watcher owner" \
        --type=email \
        --channel-labels="email_address=${ALERT_EMAIL}" \
        --project="$PROJECT"
      if [[ "$MODE" != "dry-run" ]]; then
        ch="$(gcloud monitoring channels list --project="$PROJECT" --filter="labels.email_address=\"${ALERT_EMAIL}\" AND type=email" --format='value(name)' | head -n1 || true)"
      fi
    fi
  else
    log "ALERT_EMAIL is unset; the policies are created without a channel. See watcher/CLOUD.md to point them at an address."
  fi
  ensure_one_alert "Veto watcher silent" "$ALERT_POLICY_FILE" "$ch"
  ensure_one_alert "Veto watcher record too old" "$STALE_ALERT_POLICY_FILE" "$ch"
}

deploy() {
  require_local_inputs
  if [[ "$MODE" == "check" ]]; then
    log "check ok: local inputs present for project ${PROJECT} region ${REGION} bucket ${BUCKET}"
    return 0
  fi
  require_gcloud
  if [[ "$MODE" != "dry-run" ]]; then
    require_services
  fi

  local sa_email="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  local image="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${IMAGE_NAME}:latest"
  local once_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_NAME}:run"
  local stale_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${STALE_JOB_NAME}:run"
  env_file="$(mktemp)"
  write_env_file "$env_file"

  ensure_sa "$sa_email"
  ensure_bucket
  ensure_secret
  ensure_ar_repo

  local project_number
  if [[ "$MODE" == "dry-run" ]]; then
    project_number="PROJECT_NUMBER"
  else
    project_number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
    [[ -n "$project_number" ]] || die "could not read project number for ${PROJECT}"
  fi

  run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
    --location="$REGION" \
    --member="serviceAccount:${project_number}@cloudbuild.gserviceaccount.com" \
    --role="roles/artifactregistry.writer" \
    --project="$PROJECT"

  run gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/storage.objectAdmin" \
    --project="$PROJECT"

  run gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT"

  run gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/logging.logWriter" \
    --quiet

  run gcloud iam service-accounts add-iam-policy-binding "$sa_email" \
    --member="serviceAccount:service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser" \
    --project="$PROJECT"

  run gcloud builds submit "${ROOT}/watcher" \
    --tag="$image" \
    --project="$PROJECT"

  run gcloud run jobs deploy "$JOB_NAME" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=1 \
    --task-timeout=15m \
    --cpu=1 \
    --memory=1Gi \
    --set-secrets="/keys/agent.json=${SECRET_NAME}:latest" \
    --env-vars-file="$env_file" \
    --command=node \
    --args=dist/index.js,once

  run gcloud run jobs deploy "$STALE_JOB_NAME" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=0 \
    --task-timeout=5m \
    --cpu=1 \
    --memory=512Mi \
    --set-secrets="/keys/agent.json=${SECRET_NAME}:latest" \
    --env-vars-file="$env_file" \
    --command=node \
    --args=dist/index.js,stale

  cleanup_env_file

  run gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
    --region="$REGION" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/run.invoker" \
    --project="$PROJECT"

  run gcloud run jobs add-iam-policy-binding "$STALE_JOB_NAME" \
    --region="$REGION" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/run.invoker" \
    --project="$PROJECT"

  ensure_scheduler "$SCHEDULER_JOB" "0 0,6,12,18 * * *" "$once_uri" "$sa_email"
  ensure_scheduler "$STALE_SCHEDULER_JOB" "0 * * * *" "$stale_uri" "$sa_email"
  ensure_alert

  log "deployed ${JOB_NAME} in ${REGION} on ${PROJECT}"
  log "scheduler ${SCHEDULER_JOB} in ${SCHEDULER_LOCATION} (Europe/Stockholm 00,06,12,18)"
  log "stale job ${STALE_JOB_NAME} hourly; alert policies 'Veto watcher silent' and 'Veto watcher record too old'"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  deploy
fi
