# The Google Cloud project behind the watcher

Written 2026-09-21, after the setup rather than before it, which is the wrong order and is why
`scripts/gcp-verify.sh` exists: every claim below is asserted by that script against the live
project, so this file can be checked rather than believed.

The watcher had been running from a terminal on a laptop. The deck and the video both show a real
week of decisions against real electricity prices, and an hour the watcher is not running is an
hour that is simply missing on the 8th of October and cannot be recreated. That is the only reason
any of this exists.

## What was created

| | |
|---|---|
| Project | `veto-watcher-260921`, number `472736420070`, `Veto Watcher` |
| Created | 2026-09-21T11:36:55Z |
| Billing | linked to `01778E-30EA11-E3BA6D`, currency SEK |
| Labels | `environment=development`, `owner=arlen`, `purpose=veto-watcher` |
| Budget | `veto-watcher spend alert (does not stop spend)`, 200 SEK, scoped to this project alone, notifies at 50, 90 and 100 percent. It does not stop anything; the name says so because a budget called a cap gets trusted as one |
| Audit | Secret Manager `DATA_READ` and `DATA_WRITE` logged, so every read of the agent key leaves a trail |
| APIs | run, cloudscheduler, secretmanager, artifactregistry, cloudbuild, storage (`storage.googleapis.com` and `storage-api.googleapis.com`), monitoring, billingbudgets |

## Why a separate project rather than an existing one

The account holds SafePlace, Aegis and four others. Veto is a hackathon entry that may be thrown
away on the 10th of October or may become its own thing, and either way its agent key and its
secrets should not sit in the same IAM boundary as SafePlace production. A separate project also
means the whole thing can be deleted in one command, and the cost is its own line rather than
noise inside another product.

## What is deliberately NOT here yet

Named because an undocumented gap reads as an oversight later, and because the reviewer should be
able to tell the two apart.

- **No service account for the job yet.** One service account does exist,
  `472736420070-compute@developer.gserviceaccount.com`, the default compute account that GCP
  creates by itself when the APIs are enabled. Nobody asked for it. Whether anything uses it is
  not asserted anywhere and should not be read as a claim. It holds
  no project level role binding today, which is better than the historical default of Editor, but
  a Cloud Run job deployed without being told which identity to use will pick it up. The job needs
  its own account with the narrowest set of permissions that lets it read one secret, read and
  write one bucket object, and write logs, and that belongs with the deployment script on
  `feat/watcher-cloud-run`, because the permissions follow from what the job actually does and
  inventing them ahead of the code would mean guessing.

  This entry was wrong when first written. It said no service account existed at all.
  `scripts/gcp-verify.sh` failed on it the first time it ran, which is the reason that script
  asserts the absences as well as the presences.
- **No bucket, no Artifact Registry repository, no job, no scheduler.** Same reason. The APIs are
  enabled so that the deployment script does not have to enable them and then wait.
- **No secret yet.** The agent key goes in at deployment time from a path the operator gives, and
  it has never been in this repository or in an image.
- **Cloud Scheduler does not exist in `europe-north1`.** Cloud Run runs there; the schedule has to
  live in the nearest region that serves Scheduler, `europe-west1`. The cadence is in
  Europe/Stockholm either way, which is what decides when the prices are read. Found by the verify
  script rather than by reading documentation, and it contradicts the region assumption written
  into the deployment brief.

- **No teardown date enforced.** The label says development; nothing deletes the project on a
  timer. Deleting it is a deliberate act, documented below.

## What could bite, honestly

- The default compute service account on a new project carries broad permissions. If the job is
  deployed without being given its own identity, it will run with far more access than it needs.
  This is the single most likely way this setup goes wrong, and it is why the service account is
  called out above rather than left implicit.
- A Cloud Scheduler misconfiguration can invoke a job far more often than intended. The budget is
  the backstop, not the fix, and 200 SEK is chosen to be noticed rather than to be affordable.
- The budget alerts by email to the billing account administrators. Nobody has confirmed that
  address is read. A budget nobody reads is decoration.

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
Every check runs and every failure prints, so one broken claim cannot hide the next; the exit code
is non-zero if any check failed.

The rule it enforces on itself: a check may not pass because it could not look. The first version
counted resources with `gcloud ... 2>/dev/null | wc -l` and compared the count to zero, so a gcloud
that failed for any reason at all produced an empty list, a count of zero, and a green tick. It
would have reported a clean project while being blind to it. Every call goes through a wrapper that
fails the claim when the command fails.
