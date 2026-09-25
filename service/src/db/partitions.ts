import type { Tx } from './transaction.js';
export async function ensureMonth(tx: Tx, timestamp: string | Date): Promise<void> {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (!Number.isFinite(date.getTime()) || year < 1000 || year > 9998) {
    throw new Error('block_time must be a valid timestamp in years 1000 through 9998');
  }
  const start = new Date(Date.UTC(year, month, 1)).toISOString();
  const end = new Date(Date.UTC(year, month + 1, 1)).toISOString();
  const name = `decisions_${year}_${String(month + 1).padStart(2, '0')}`;
  // Values are generated from validated UTC calendar components, never raw SQL input.
  await tx.query(`CREATE TABLE IF NOT EXISTS ${name} PARTITION OF decisions FOR VALUES FROM ('${start}') TO ('${end}')`);
}
