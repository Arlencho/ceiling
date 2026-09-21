# The Google Cloud project behind the watcher

Project `veto-watcher-260921` (number `472736420070`, display name `Veto Watcher`) is the watcher
project. Billing is linked, a 200 SEK budget alert is set, Secret Manager data access is audited,
and the APIs in the table below are enabled. The Cloud Run job, the scheduler, the journal bucket,
and the agent-key secret are created when `scripts/deploy-watcher-cloud.sh` runs. That script has
not been run, so those resources are not in the project yet.

`scripts/gcp-verify.sh` checks the table against the live project and changes nothing.

The watcher has been running from a laptop. The deck and the video are written for a week of
decisions against real electricity prices. That week is not on chain yet. An hour the watcher
is not running is an hour missing from that week on the 8th of October, and it cannot be
recreated.

## What was created

| | |
|---|---|
| Project | `veto-watcher-260921`, number `472736420070`, `Veto Watcher` |
| Created | 2026-09-21T11:36:55Z |
| Billing | linked to `01778E-30EA11-E3BA6D`, currency SEK |
| Labels | `environment=development`, `owner=arlen`, `purpose=veto-watcher` |
| Budget | `veto-watcher spend alert (does not stop spend)`, 200 SEK, scoped to this project alone, notifies at 50, 90 and 100 percent. It notifies. It does not stop spend. |
| Audit | Secret Manager `DATA_READ` and `DATA_WRITE` logged, so every read of the agent key leaves a trail |
| APIs | run, cloudscheduler, secretmanager, artifactregistry, cloudbuild, storage (`storage.googleapis.com` and `storage-api.googleapis.com`), monitoring, billingbudgets |

## Before the agent key is loaded

`scripts/deploy-watcher-cloud.sh` is in the tree. It has not been run against this project, so the bucket, secret, job and scheduler still do not exist. Three checks run before the agent key is stored.

1. **Default compute account and secret versions.** The account a Cloud Run job picks up when nobody names one is `472736420070-compute@developer.gserviceaccount.com`. Before the script creates the secret (or adds a version), it reads the project IAM policy and, if the secret already exists, the secret IAM policy. If that account has a role that grants `secretmanager.versions.access` (`roles/owner`, `roles/secretmanager.admin`, `roles/secretmanager.secretAccessor`, or another role whose included permissions contain that permission), the script stops and names the role and the policy it was found on. It also tries the organization and folder policies. When those cannot be read it says so. A missing line at those levels is not treated as missing access.
2. **Public access prevention on the journal bucket.** Uniform bucket-level access is already on create. The script also sets public access prevention to enforced when it creates the bucket and when the bucket already exists, then reads the setting back. If it cannot be set, the script stops.
3. **Named inventory of who can read a secret version.** `scripts/gcp-verify.sh` lists every principal on the project policy and on each secret policy whose role grants `secretmanager.versions.access`, and for each prints the role and which policy it came from. The listing states that it cannot see bindings above the project, so a short list is not a complete list of who can read a secret version.

The job service account `veto-watcher@veto-watcher-260921.iam.gserviceaccount.com` is created by that deploy script when it runs. It is the identity the jobs are given. The default compute account is not granted a role by the script.

## Project boundary

The same account holds SafePlace, Aegis, and four other projects. This project is separate so the
watcher agent key and its secrets sit outside the SafePlace production IAM boundary. The project
can be deleted in one command, and its cost is its own line.

## What is not in the project yet

Public access prevention, the default-compute secret check, and the principal listing are in the
scripts above.

- **No job service account, bucket, Artifact Registry repository, job or scheduler in the live
  project yet.** The deploy script creates them when the owner runs it. One service account does
  exist today, `472736420070-compute@developer.gserviceaccount.com`, the default compute account
  that GCP creates by itself when the APIs are enabled. It holds no project level role binding
  today. A Cloud Run job deployed without `--service-account` picks that account up. The deploy
  script passes `veto-watcher@veto-watcher-260921.iam.gserviceaccount.com` and refuses to store the
  agent key if the default account can already read a secret version. This bullet was wrong when
  first written. It said no service account existed at all. `scripts/gcp-verify.sh` failed on it
  the first time it ran, which is why that script asserts the absences as well as the presences.
- **No secret yet.** The agent key goes in at deployment time from a path the operator gives, and
  it has never been in this repository or in an image. The deploy script will not create it until
  the default compute account check above has passed.
- **Cloud Scheduler does not exist in `europe-north1`.** Cloud Run runs there. The schedule lives
  in the nearest region that serves Scheduler, `europe-west1`. The cadence is Europe/Stockholm,
  which is what decides when the prices are read.

- **No teardown date enforced.** The label says development; nothing deletes the project on a
  timer. Deleting it is a deliberate act, documented below.

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

That removes the job, the scheduler, the bucket, the images and the secret with it. The budget
lives on the billing account rather than the project and is removed separately:

```
gcloud billing budgets delete 914d5c6c-9361-437b-8ea6-dd7b50ab333d \
  --billing-account=01778E-30EA11-E3BA6D
```

## Checking it

```
scripts/gcp-verify.sh
```

Read only. It asserts every claim in the table above against the live project and changes nothing.
The sections below the table are not asserted.
Every check runs and every failure prints, so one broken claim cannot hide the next; the exit code
is non-zero if any check failed.

A check does not pass when the command could not look. A failed gcloud call fails the claim. An
empty list is not counted as zero resources.
