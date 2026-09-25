#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, totalmem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { generate, type TxViewOut } from '../gen/src/gen.js';
import { base58Encode } from '../gen/src/keys.js';
import { pool } from '../../../service/src/db/transaction.js';
import { migrate } from '../../../service/src/db/migrate.js';
import { ingestTransaction, type Rpc } from '../../../service/src/sources/shared.js';
import { backfill } from '../../../service/src/sources/backfill.js';
import type { RpcTransaction } from '../../../service/src/decode/index.js';

export function rpcTransaction(tx: TxViewOut): RpcTransaction {
  return { slot: tx.slot, blockTime: tx.blockTime,
    transaction: { signatures: [tx.signature], message: { accountKeys: tx.accountKeys,
      instructions: tx.instructions.map(ix => ({ programIdIndex: tx.accountKeys.indexOf(ix.programId),
        accounts: ix.accounts.map(key => tx.accountKeys.indexOf(key)), data: base58Encode(ix.data) })) } },
    meta: { err: tx.err, logMessages: tx.logs } };
}
const noRpc: Rpc = async () => { throw new Error('Unexpected network lookup'); };
const tables = ['decisions', 'decision_keys', 'deltas', 'rule_stats', 'agent_stats'] as const;
async function truncate() {
  await pool.query('TRUNCATE decisions, decision_keys, deltas, rule_stats, agent_stats, rules, cursors');
}
async function snapshot() {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    // Source provenance and wall-clock update times necessarily differ between runs.
    result[table] = (await pool.query(`SELECT to_jsonb(t) - 'source' - 'updated_at' AS row FROM ${table} t ORDER BY (to_jsonb(t) - 'source' - 'updated_at')::text`)).rows.map(r => r.row);
  }
  return result;
}
function fixture(seed: number, transactions: number) {
  return generate({ agents: 4, rules: 2, transactions, seed, paid: 60, refused: 30, override: 10 }).map(g => rpcTransaction(g.tx));
}
async function determinism() {
  await truncate();
  const set = fixture(42, 128);
  for (const tx of set) assert.equal(await ingestTransaction(tx, 'webhook', noRpc), 1);
  const before = await snapshot();
  await truncate();
  const history = set.slice().reverse();
  const bySignature = new Map(set.map(tx => [tx.transaction.signatures[0], tx]));
  const rpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    if (method === 'getTransaction') return bySignature.get(String(params[0])) as T;
    if (method === 'getSignaturesForAddress') {
      const options = params[1] as { before?: string; limit: number };
      const start = options.before ? history.findIndex(tx => tx.transaction.signatures[0] === options.before) + 1 : 0;
      return history.slice(start, start + options.limit).map(tx => ({ signature: tx.transaction.signatures[0], slot: tx.slot })) as T;
    }
    throw new Error(`Unexpected method ${method}`);
  };
  await backfill(rpc);
  assert.deepEqual(await snapshot(), before);
  const counts = Object.fromEntries(tables.map(table => [table, before[table].length]));
  console.log('Determinism identical:', counts);
  return { identical: true, rows: counts, excluded_columns: ['decisions.source', 'rule_stats.updated_at', 'agent_stats.updated_at'] };
}
function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
async function measure(target: number, duration: number) {
  await truncate();
  const latencies: number[] = [];
  let committed = 0, seed = 100, batch: RpcTransaction[] = [], index = 0;
  const start = performance.now(), epoch = Date.now();
  while (performance.now() - start < duration * 1000) {
    const due = committed * 1000 / target;
    const wait = due - (performance.now() - start);
    if (wait > 0) await sleep(wait);
    if (performance.now() - start >= duration * 1000) break;
    if (index === batch.length) { batch = fixture(seed++, 992); index = 0; }
    const tx = batch[index++];
    // A virtual arrival queue avoids allocating millions of pending transactions.
    // Preserve RPC timestamp precision, including its up-to-one-second quantization.
    tx.blockTime = Math.floor((epoch + due) / 1000);
    const count = await ingestTransaction(tx, 'webhook', noRpc);
    assert.equal(count, 1);
    committed += count;
    latencies.push(Date.now() - tx.blockTime * 1000);
  }
  const elapsed = (performance.now() - start) / 1000;
  const rows = Number((await pool.query('SELECT count(*) FROM decisions')).rows[0].count);
  assert.equal(rows, committed);
  const physicalRows = Number((await pool.query(`SELECT
    (SELECT count(*) FROM decisions) + (SELECT count(*) FROM decision_keys) +
    (SELECT count(*) FROM deltas) + (SELECT count(*) FROM rule_stats) +
    (SELECT count(*) FROM agent_stats) AS n`)).rows[0].n);
  const bytes = Number((await pool.query(`SELECT sum(pg_total_relation_size(c.oid)) AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname <> 'schema_migrations'`)).rows[0].bytes);
  latencies.sort((a,b) => a-b);
  const percentile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length*p)-1)] ?? null;
  return { target_events_per_second: target, duration_seconds: duration, elapsed_seconds: elapsed,
    offered_events: Math.floor(target * duration), committed_events: committed,
    unprocessed_events: Math.max(0, Math.floor(target * duration) - committed),
    sustained_events_per_second: committed / elapsed, decision_rows_per_second: rows / elapsed,
    database_rows: physicalRows, database_rows_per_second: physicalRows / elapsed,
    p50_event_to_commit_ms: percentile(.5), p99_event_to_commit_ms: percentile(.99),
    relation_bytes: bytes, bytes_per_million_decisions: bytes / rows * 1e6,
    bytes_per_million_database_rows: bytes / physicalRows * 1e6 };
}
async function main() {
  // Every connection uses a private schema. Never truncate the application's tables.
  const schema = `replay_${randomBytes(12).toString('hex')}`;
  let created = false;
  process.env.PGOPTIONS = `${process.env.PGOPTIONS ?? ''} -c search_path=${schema}`;
  try {
    const version = (await pool.query('SHOW server_version')).rows[0].server_version as string;
    if (!version.startsWith('16.')) throw new Error('Replay requires Postgres 16');
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await migrate();
    const duration = positive('VETO_REPLAY_SECONDS', 60);
    const deterministic = await determinism();
    const runs = [];
    for (const target of [1000, 10000, 100000]) {
      const result = await measure(target, duration); runs.push(result); console.log(result);
    }
    const metadata = { machine: `${cpus()[0]?.model}, ${cpus().length} CPUs, ${totalmem()} bytes RAM`,
      os: `${platform()} ${release()}`, node: process.version, postgres: version,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      duration_seconds: duration,
      conditions: 'Single-machine lower bound; serial shared ingestTransaction; synthetic mixed events; lazy virtual arrival queue; no drain; generation included; event timestamps rounded down to seconds; commit acknowledgment is an upper bound for agent_stats visibility; relation bytes include indexes and TOAST, exclude WAL; Compose tmpfs storage, not physical disk IO' };
    await writeFile(new URL('../../reports/replay.json', import.meta.url), JSON.stringify({ metadata, determinism: deterministic, runs }, null, 2) + '\n');
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
