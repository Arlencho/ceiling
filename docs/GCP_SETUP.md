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
