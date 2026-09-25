# Local replay

Set POSTGRES_PASSWORD in the environment, then run `make -C loadtest loadtest`.
Requires Docker Compose, Node 22+, and the repository's Anchor and Rust toolchain.
`VETO_REPLAY_SECONDS` defaults to 60 seconds per target (1000, 10000, 100000 events/s).
For a smoke run use `VETO_REPLAY_SECONDS=2 VETO_LOADTEST_MANDATES=10 VETO_LOADTEST_CHARGES=40`.
CU uses counts rather than a timed duration. Its measured duration is recorded in cu.json.

Replay imports the generator and the exact service adapter used by webhook and backfill.
No RPC network access is used. Every generated transaction has one decision, with eight
opening transactions per 1000-event batch and a 60/30/10 paid/refused/override mix.
The consumer is serial. Offered arrivals follow the target clock in a virtual queue;
only transactions reached during the window are materialized. Unprocessed demand is
reported, not silently discarded or counted as ingested. Generation time is included.
One in-flight transaction can finish after the deadline; elapsed time includes it.
This measures this runner and service configuration, not maximum parallel capacity.

Latency runs from the scheduled event timestamp (rounded down to RPC whole seconds)
to commit acknowledgment, after agent_stats has updated in the same transaction.
It includes queue delay and up to one second of timestamp quantization. Percentiles
cover committed events only; unprocessed events have no finite measured latency.
Database rows include decisions, decision_keys, deltas, rule_stats and agent_stats.
Relation bytes include table/index/TOAST allocation, exclude WAL and cluster overhead,
and are normalized by both decisions and database rows. Small runs include allocation
and empty-partition overhead. Compose uses tmpfs, so this is allocated relation size,
not a physical-disk durability or IO measurement.

The determinism phase runs generated transactions through webhook's shared adapter,
truncates its private schema, invokes the real backfill scanner against an in-memory
RPC history, and deep-compares sorted business rows in decisions, decision_keys,
deltas, rule_stats and agent_stats. Only source and updated_at are
excluded because they describe the ingestion run. It prints each table's row count
and fails on any other difference. A private per-process schema is dropped on exit.
No application tables are truncated. Do not pass PGOPTIONS with a custom search_path.

SCALE.md is generated only from report files. Missing provenance is printed as
not recorded, never inferred from the machine generating the document.
