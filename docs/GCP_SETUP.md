# The Google Cloud project behind the watcher

Project `veto-watcher-260921` (number `472736420070`, display name `Veto Watcher`) is the watcher
project. Billing is linked, a 200 SEK budget alert is set, Secret Manager data access is audited,
and the APIs in the table below are enabled. `scripts/deploy-watcher-cloud.sh` has been run.
The job service account, the journal bucket, the Artifact Registry repository, the Cloud Run
jobs, the scheduler jobs, and the secret `veto-agent-keypair` are in the project. The inventory
is under [What the deploy created](#what-the-deploy-created).

`scripts/gcp-verify.sh` checks the [What was created](#what-was-created) table against the live project and changes nothing. It still expects the deployed resources to be absent, so a live run exits non-zero. See [Checking it](#checking-it).

The watcher currently runs from an operator machine. This project exists so it can run unattended in Cloud Run instead.

## What was created

| | |
|---|---|
| Project | `veto-watcher-260921`, number `472736420070`, `Veto Watcher` |
| Created | 2026-09-21T11:36:55Z |
| Billing | linked, currency SEK |
| Labels | `environment=development`, `owner=arlen`, `purpose=veto-watcher` |
| Budget | `veto-watcher spend alert (does not stop spend)`, 200 SEK, scoped to this project alone, notifies at 50, 90 and 100 percent. It notifies. It does not stop spend. |
| Audit | Secret Manager `DATA_READ` and `DATA_WRITE` logged, so every read of the agent key leaves a trail |
| APIs | run, cloudscheduler, secretmanager, artifactregistry, cloudbuild, storage (`storage.googleapis.com` and `storage-api.googleapis.com`), monitoring, billingbudgets |

## Before the agent key is loaded

`scripts/deploy-watcher-cloud.sh` is in the tree and has been run against this project. The bucket, secret, jobs, and scheduler exist. Two checks run before the agent key is stored, including on a later run that adds a secret version.

1. **Default compute account and secret versions.** The account a Cloud Run job picks up when nobody names one is `472736420070-compute@developer.gserviceaccount.com`. Before the script creates the secret (or adds a version), it reads the project IAM policy and, if the secret already exists, the secret IAM policy. If that account has a role that grants `secretmanager.versions.access` (`roles/owner`, `roles/secretmanager.admin`, `roles/secretmanager.secretAccessor`, or another role whose included permissions contain that permission), the script stops and names the role and the policy it was found on. It also tries the organization and folder policies. When those cannot be read it says so. A missing line at those levels is not treated as missing access.
2. **Public access prevention on the journal bucket.** Uniform bucket-level access is already on create. The script also sets public access prevention to enforced when it creates the bucket and when the bucket already exists, then reads the setting back. If it cannot be set, the script stops.

`scripts/gcp-verify.sh` is a separate read-only audit. It is not part of the deploy. It lists every principal on the project policy and on each secret policy whose role grants `secretmanager.versions.access`, and for each prints the role and which policy it came from. The listing states that it cannot see bindings above the project, so a short list is not a complete list of who can read a secret version.

The job service account `veto-watcher@veto-watcher-260921.iam.gserviceaccount.com` is the identity the jobs are given. It has `roles/secretmanager.secretAccessor` on the secret `veto-agent-keypair`. The default compute account is not granted a role by the script. On 2026-09-23 it held no project level role, and it was absent from the readable policies that grant `secretmanager.versions.access`.

## Project boundary

This project is separate so the watcher agent key and its secrets sit in their own IAM. The project can be deleted in one command, and its cost is its own line.

## What the deploy created

`scripts/gcp-verify.sh` on 2026-09-23, authenticated as the project owner, printed `passed: 30  failed: 6`. The six failures are absence checks whose `actual` values are this inventory. `no Cloud Run service yet` passed: there is no Cloud Run service.

| | |
|---|---|
| Job service account | `veto-watcher@veto-watcher-260921.iam.gserviceaccount.com` |
| Secret access | That account has `roles/secretmanager.secretAccessor` on `veto-agent-keypair`. The project policy also grants `roles/owner` to the project owner's user account. The default compute account, `472736420070-compute@developer.gserviceaccount.com`, is not in that list and holds no project level role. |
| Journal bucket | `veto-watcher-260921-journal` |
| Other bucket | `veto-watcher-260921_cloudbuild`, in the same bucket list |
| Secret | `veto-agent-keypair`. The key is not in this repository and not in an image. The deploy script will not add a version until the default compute account check above has passed. |
| Cloud Run jobs | `veto-watcher`, `veto-watcher-stale` |
| Cloud Run services | none |
| Cloud Scheduler jobs | `veto-watcher-cadence`, `veto-watcher-stale-hourly` |
| Artifact Registry | repository `veto-watcher` |

Cloud Scheduler does not exist in `europe-north1`. Cloud Run runs there. The schedule lives in the nearest region that serves Scheduler, `europe-west1`. The cadence is Europe/Stockholm, which is what decides when the prices are read.

The default compute account is what a Cloud Run job picks up when nobody names one. The deploy script passes `veto-watcher@veto-watcher-260921.iam.gserviceaccount.com` and refuses to store the agent key if the default account can already read a secret version.

**No teardown date enforced.** The label says development. Nothing deletes the project on a timer. Deleting it is a deliberate act, documented below.

## Operating notes

- The default compute service account on a new project carries broad permissions. A job deployed
  without its own identity runs with that account. The deploy script passes a dedicated account
  and stops before creating the secret if the default compute account can already read a secret
  version.
- A Cloud Scheduler misconfiguration can invoke a job far more often than intended. The budget
  alert does not stop the job. 200 SEK is the amount chosen so the alert is noticed.
- The budget alerts by email to the billing account administrators. Nothing in this repository
  confirms that inbox is read.

## Tearing it down

```
gcloud projects delete veto-watcher-260921
```

That removes the job, the scheduler, the bucket, the images and the secret with it. The budget `veto-watcher spend alert (does not stop spend)` lives on the billing account rather than the project. Deleting the project does not delete it. Remove that budget on the billing account when you tear the project down.

## Checking it

```
scripts/gcp-verify.sh
```

Read only. It asserts every claim in the [What was created](#what-was-created) table against the live project and changes nothing.
It also asserts that the resources under [What the deploy created](#what-the-deploy-created) are absent. Those checks are named `no service account beyond the one GCP created by itself`, `no bucket yet`, `no secret yet`, `no Cloud Run job yet`, `no Cloud Scheduler job yet`, and `no Artifact Registry repo yet`. On 2026-09-23 each of them failed, and the `actual` lines are the table in that section. `no Cloud Run service yet` passed.
Every check runs and every failure prints, so one broken claim cannot hide the next. The exit code
is non-zero if any check failed. On that date the script printed `passed: 30  failed: 6`.

A check does not pass when the command could not look. A failed gcloud call fails the claim. An
empty list is not counted as zero resources.

## Rule switch on 2026-09-25

Read with `gcloud run jobs describe` before either job was updated. Both jobs carried the same environment. The api key in `VETO_RPC` is redacted below. The live value was not changed.

Image before the switch: `europe-north1-docker.pkg.dev/veto-watcher-260921/veto-watcher/watcher:40a414c`.

| | `veto-watcher` | `veto-watcher-stale` |
|---|---|---|
| Command | `node dist/index.js once` | `node dist/index.js stale` |
| CPU / memory | 1 / 1Gi | 1 / 512Mi |
| Task timeout | 900s | 300s |
| Max retries | 1 | 0 |
| Service account | `veto-watcher@veto-watcher-260921.iam.gserviceaccount.com` | same |
| Secret | `veto-agent-keypair` `latest`, mounted at `/keys/agent.json` | same |

Environment on both jobs before the switch:

| Name | Value |
|---|---|
| `VETO_RPC` | `https://devnet.helius-rpc.com/REDACTED` |
| `VETO_PROGRAM_ID` | `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV` |
| `VETO_MINT` | `2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU` |
| `VETO_OWNER` | `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq` |
| `VETO_OWNER_TOKEN` | `23gnGjWJMskzuFgdGs8atieGojf9oGGkF4LSfa8MaN2g` |
| `VETO_MERCHANT` | `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG` |
| `VETO_MERCHANT_TOKEN` | `2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F` |
| `VETO_AGENT` | `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w` |
| `VETO_KEYS_DIR` | `/keys` |
| `VETO_JOURNAL` | `/tmp/veto/decisions.jsonl` |
| `VETO_JOURNAL_GCS` | `gs://veto-watcher-260921-journal/decisions-seeker-rule.jsonl` |
| `VETO_MANDATE_ID` | `1790290106235` |
| `VETO_KWH_MILLI` | `6000` |
| `VETO_MINT_DECIMALS` | `6` |
| `VETO_PURPOSE` | `Charging top-ups at the SE3 spot rate` |
| `VETO_CAP` | `300000000` |
| `VETO_PER_TX_MAX` | `10000000` |

`VETO_QUOTE_CURRENCY` was unset, so the watcher treated 1 token as 1 SEK.

Values written by the in-place update. Every name not in this list stays as it was, including `VETO_RPC`, `VETO_PROGRAM_ID`, and the secret mount.

| Name | Value |
|---|---|
| `VETO_MINT` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| `VETO_MINT_DECIMALS` | `6` |
| `VETO_OWNER` | `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq` |
| `VETO_OWNER_TOKEN` | `8eyjxUJNHuuqYrbqoFxacu4Qx54ystkGirewxigfJtLm` |
| `VETO_MANDATE_ID` | `1790347056578` |
| `VETO_MERCHANT` | `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG` |
| `VETO_MERCHANT_TOKEN` | `GDb2L2oQc6LP4nii8ahUX3pqDUNVUn36nPNVafhhtZ7i` |
| `VETO_AGENT` | `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w` |
| `VETO_KWH_MILLI` | `6000` |
| `VETO_QUOTE_CURRENCY` | `USD` |
| `VETO_JOURNAL_GCS` | `gs://veto-watcher-260921-journal/decisions-usdc-rule.jsonl` |

The new journal object is created empty only when it is missing. `decisions-seeker-rule.jsonl` and `decisions.jsonl` are not rewritten.

Both jobs were updated to image `europe-north1-docker.pkg.dev/veto-watcher-260921/veto-watcher/watcher:033a193`. That tag and `:latest` are digest `sha256:4379c861f192b6c804507eb8ead1d5d3fe97f48b1871fe1930762edcf5dd9eed`, built from commit `033a193`. A describe after the update showed the new values on both jobs. `VETO_RPC`, `VETO_PROGRAM_ID`, the secret mount, the command, the task timeout, and the resources were unchanged.

Before the update, mandate `UsRHyKtm41XMpQUcFGevYKgdWJEHQUf44QDCxLjEGWh` was read through the SDK against the job's RPC. It is the PDA for owner `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq` and mandate id `1790347056578` under program `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`. Status was active (`0`), expiry `1793802976` was still in the future, agent was `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w`, mint was USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, source was `8eyjxUJNHuuqYrbqoFxacu4Qx54ystkGirewxigfJtLm`, and merchant was `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG`. Cap `20000000`, per-transaction max `500000`, spent `0`, last nonce `0`.

Cloud Build's default service account for this project is `472736420070-compute@developer.gserviceaccount.com`. It could not read the Cloud Build source bucket, so the image build could not start. `roles/storage.objectViewer` was added on `gs://veto-watcher-260921_cloudbuild` and `roles/artifactregistry.writer` was added on repository `veto-watcher` in `europe-north1`, both for that account. No project-level role was added, and the agent secret was not read or changed.

# The index service on Google Cloud

`scripts/deploy-index-cloud.sh` puts the `service/` package (read API, webhook receiver,
backfill) on Cloud Run with a Cloud SQL Postgres 16 database. It mirrors the watcher
deploy: owner-run, idempotent, refuses before creating anything when an input is
missing. Unlike the watcher script it has no default project or region: both must be
passed explicitly, and the working tree must be clean so the image tag matches a commit.

The script is verified offline only: `--check`, `--dry-run`, and the stubbed `gcloud`
runs in `scripts/deploy-index-cloud.test.sh`. No live project has been created from it.
Run it first with `--dry-run` and read the plan.

```bash
export PROJECT=my-index-project       # no default, required
export REGION=europe-north1           # no default, required
export INDEX_WEBHOOK_AUTH='...'       # exact Authorization header Helius sends
export VETO_RPC='https://...'         # never printed, stored in Secret Manager
./scripts/deploy-index-cloud.sh --check
./scripts/deploy-index-cloud.sh --dry-run
./scripts/deploy-index-cloud.sh
```

## What the index deploy creates

| | |
|---|---|
| Service account | `veto-index@<PROJECT>.iam.gserviceaccount.com`. Roles: `roles/secretmanager.secretAccessor` on each of the three secrets (per-secret binding), `roles/cloudsql.client` on the project for the connector, `roles/run.invoker` on the backfill job. Nothing else. |
| Cloud SQL | Instance `veto-index-pg`, Postgres 16, `db-f1-micro`, 10 GB HDD, zonal, no deletion protection. Public IP with no authorized networks: only the Cloud SQL connector can reach it. Database `veto_index`, user `veto_index_app`. |
| Secrets | `veto-index-webhook-auth` (from `INDEX_WEBHOOK_AUTH`), `veto-index-database-url` (generated once, paired with the database user), `veto-index-rpc-url` (from `VETO_RPC`). Values are staged in a private temp directory and passed with `--data-file`; they are never printed and never appear on a logged command line. The generated database password is masked as `***` in `--dry-run` output. |
| Artifact Registry | Repository `veto-index`; the image tag is the short commit of `HEAD`. |
| Cloud Run services | `veto-index` (read API) and `veto-index-webhook`, each with `--min-instances=1`, 1 vCPU, 512 MiB, the Cloud SQL connector, and only the secrets each one needs. Both allow unauthenticated ingress: the read API is public GET only, and the webhook returns 401 without the auth header. |
| Cloud Run jobs | `veto-index-migrate` and `veto-index-backfill`. On every deploy the migration job is deployed with the new image and executed to completion first; only then do the new service revisions roll out. |
| Cloud Scheduler | `veto-index-backfill-hourly` in `europe-west1` (Scheduler is not offered in `europe-north1`), hourly at minute 13, Europe/Stockholm, invoking the backfill job as the service account. |

The container entrypoint translates `DATABASE_URL` into the `PG*` variables
node-postgres reads; the socket path in the URL (`host=/cloudsql/...`) is what routes
the connection through the connector. If the database user and the database-url secret
get out of sync (exactly one exists), the script refuses rather than guess, because the
password is not recoverable.

## Cost per month (estimate)

Smallest tiers, list prices from the Cloud Run, Cloud SQL, Secret Manager, Scheduler,
and Artifact Registry pricing pages as of September 2026, `europe-north1`, no free tier
assumed. Re-check the pricing pages before budgeting; these numbers are a basis, not a
quote.

| Item | Basis | Estimate |
|---|---|---|
| Cloud SQL `db-f1-micro` | about $0.0116 per hour, always on | about $8.50 |
| Cloud SQL storage and backups | 10 GB HDD at $0.09 per GB, 10 GB backup at $0.08 per GB | about $1.70 |
| Cloud Run min instances | 2 services x 1 idle vCPU ($0.0000025 per vCPU-second) and 0.5 GiB ($0.0000025 per GiB-second) | about $19.00 |
| Backfill job | 720 hourly runs x 30 s at 1 vCPU and 512 MiB | under $1.00 |
| Cloud Scheduler | 1 job at $0.10 per month | $0.10 |
| Secret Manager | 3 active secret versions at $0.06 plus access operations | under $0.50 |
| Artifact Registry | about 0.5 GB at $0.10 per GB | under $0.10 |

Total: roughly $30 per month, dominated by the two always-on Cloud Run instances and
the Cloud SQL instance. Dropping `--min-instances` to 0 on the webhook service saves
about $9.50 per month at the cost of a cold start on the first delivery after idle;
Helius retries, so ingestion catches up.

## Rolling back the index service

A bad revision: traffic moves back in one command, because old revisions are kept.
List revisions with `gcloud run revisions list --service=veto-index --region=$REGION
--project=$PROJECT`, then:

```
gcloud run services update-traffic veto-index \
  --to-revisions=<previous-revision>=100 \
  --region=$REGION --project=$PROJECT
```

Do the same for `veto-index-webhook`. Rolling back the revision does not roll back
migrations: the migration runner is additive (new tables and columns), and the previous
image keeps working against the migrated schema. If a migration itself is the problem,
restore the Cloud SQL instance from its automated backup to a new instance and point a
fresh deployment at it; do not hand-edit the schema.

Full teardown, in this order:

```
gcloud scheduler jobs delete veto-index-backfill-hourly --location=europe-west1 --project=$PROJECT --quiet
gcloud run jobs delete veto-index-migrate veto-index-backfill --region=$REGION --project=$PROJECT --quiet
gcloud run services delete veto-index veto-index-webhook --region=$REGION --project=$PROJECT --quiet
gcloud secrets delete veto-index-webhook-auth veto-index-database-url veto-index-rpc-url --project=$PROJECT --quiet
gcloud artifacts repositories delete veto-index --location=$REGION --project=$PROJECT --quiet
gcloud sql instances delete veto-index-pg --project=$PROJECT --quiet
```

The instance is created with `--no-deletion-protection` so the last command works.
Deleting the database destroys the indexed history; it is rebuildable from the chain
with a backfill, but the rebuild takes hours against public devnet RPC limits.
