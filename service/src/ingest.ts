import { transaction, type Tx } from './db/transaction.js';
import { ensureMonth } from './db/partitions.js';

export interface Decision {
  signature: string; slot: string; block_time: string | Date;
  instruction_index: number; inner_index: number; program_version: number;
  rule_kind: 'mandate' | 'hold' | 'trade'; rule: string; agent: string; owner: string;
  kind: number; reason: number; amount: string; nonce: string; counterparty: string;
  suggested_override: string | null; commitment: 'confirmed' | 'finalized';
  source: 'grpc' | 'webhook' | 'backfill' | 'logs';
}
export type DecisionKey = Pick<Decision, 'signature' | 'instruction_index' | 'inner_index'>;
const keys = (row: DecisionKey) => [row.signature, row.instruction_index, row.inner_index];
const whereKey = 'signature = $1 AND instruction_index = $2 AND inner_index = $3';
const counters = ['requests', 'paid', 'outside', 'allowances', 'declines'] as const;
type Delta = Record<typeof counters[number], string> & { rule: string; agent: string };

async function apply(tx: Tx, delta: Delta, sign: bigint) {
  for (const [table, key] of [['rule_stats', 'rule'], ['agent_stats', 'agent']] as const) {
    await tx.query(`INSERT INTO ${table} (${key}) VALUES ($1) ON CONFLICT DO NOTHING`, [delta[key]]);
    await tx.query(`UPDATE ${table} SET ${counters.map((c, i) => `${c} = ${c} + $${i + 2}`).join(', ')}, updated_at = now() WHERE ${key} = $1`,
      [delta[key], ...counters.map(c => (BigInt(delta[c]) * sign).toString())]);
  }
}

async function refresh(tx: Tx, rule: string, agent: string) {
  const { rows } = await tx.query(`SELECT d.*,
    EXISTS (SELECT 1 FROM decisions s WHERE s.rule = d.rule AND s.nonce = d.nonce AND s.kind = 3) AS has_allowance,
    EXISTS (SELECT 1 FROM decisions s WHERE s.rule = d.rule AND s.nonce = d.nonce AND s.kind = 2) AS has_refusal
    FROM decisions d WHERE d.rule = $1`, [rule]);
  for (const row of rows) {
    const paid = row.kind === 1 && !row.has_allowance ? 1 : 0;
    const outside = row.kind === 2 || (row.kind === 3 && !row.has_refusal) ? 1 : 0;
    const next: Delta = { rule, agent: row.agent, requests: String(paid + outside), paid: String(paid),
      outside: String(outside), allowances: row.kind === 3 ? '1' : '0', declines: row.kind === 100 ? '1' : '0' };
    const previous = (await tx.query(`SELECT * FROM deltas WHERE ${whereKey}`, keys(row))).rows[0] as Delta | undefined;
    const difference = { ...next };
    for (const c of counters) difference[c] = (BigInt(next[c]) - BigInt(previous?.[c] ?? '0')).toString();
    await apply(tx, difference, 1n);
    await tx.query(`INSERT INTO deltas (signature, instruction_index, inner_index, rule, agent, ${counters.join(', ')})
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (signature, instruction_index, inner_index)
      DO UPDATE SET ${counters.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [...keys(row), rule, row.agent, ...counters.map(c => next[c])]);
  }
  for (const [table, key, value] of [['rule_stats', 'rule', rule], ['agent_stats', 'agent', agent]] as const) {
    await tx.query(`UPDATE ${table} SET
      first_open_ts = (SELECT min(block_time) FROM decisions WHERE ${key} = $1 AND kind = 0 AND block_time > '1970-01-01Z'),
      first_ts = (SELECT min(block_time) FROM decisions WHERE ${key} = $1 AND block_time > '1970-01-01Z'),
      last_ts = (SELECT max(block_time) FROM decisions WHERE ${key} = $1),
      last_slot = (SELECT max(slot) FROM decisions WHERE ${key} = $1), updated_at = now()
      WHERE ${key} = $1`, [value]);
  }
}

/** Caller must supply an active READ COMMITTED transaction, normally via transaction(). */
export async function insertDecision(tx: Tx, row: Decision): Promise<boolean> {
  // Serialize writers until a finer-grained lock protocol is needed. This also
  // protects partition DDL and nonce reclassification across sources and agents.
  await tx.query('SELECT pg_advisory_xact_lock(762042)');
  const inserted = await tx.query(`INSERT INTO decision_keys (signature, instruction_index, inner_index, block_time)
    VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING signature`, [...keys(row), row.block_time]);
  if (!inserted.rowCount) return false;
  await ensureMonth(tx, row.block_time);
  const columns = ['signature', 'slot', 'block_time', 'instruction_index', 'inner_index', 'program_version',
    'rule_kind', 'rule', 'agent', 'owner', 'kind', 'reason', 'amount', 'nonce', 'counterparty',
    'suggested_override', 'commitment', 'source'] as const;
  const decision = await tx.query(`INSERT INTO decisions (${columns.join(', ')})
    VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING signature`, columns.map(c => row[c]));
  if (!decision.rowCount) throw new Error('Decision key exists without a newly inserted decision');
  await refresh(tx, row.rule, row.agent);
  return true;
}

export function reverseDecision(row: DecisionKey): Promise<boolean>;
export function reverseDecision(tx: Tx, row: DecisionKey): Promise<boolean>;
export async function reverseDecision(txOrRow: Tx | DecisionKey, row?: DecisionKey): Promise<boolean> {
  if (!row) return transaction(tx => reverseDecision(tx, txOrRow as DecisionKey));
  const tx = txOrRow as Tx;
  await tx.query('SELECT pg_advisory_xact_lock(762042)');
  const delta = (await tx.query(`SELECT * FROM deltas WHERE ${whereKey}`, keys(row))).rows[0] as Delta | undefined;
  if (!delta) return false;
  await apply(tx, delta, -1n);
  await tx.query(`DELETE FROM deltas WHERE ${whereKey}`, keys(row));
  await tx.query(`DELETE FROM decisions WHERE ${whereKey}`, keys(row));
  await tx.query(`DELETE FROM decision_keys WHERE ${whereKey}`, keys(row));
  await refresh(tx, delta.rule, delta.agent);
  return true;
}
