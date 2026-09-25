import { pathToFileURL } from 'node:url';
import { PROGRAM_ID } from '../decode/index.js';
import { pool, transaction } from '../db/transaction.js';
import { createRpc, fetchTransaction, ingestTransaction, type Rpc } from './shared.js';

type Signature = { signature: string; slot: number };
export async function backfill(rpc: Rpc = createRpc()): Promise<void> {
  // Serialize scans separately from ingestion. A failed scan can replay safely,
  // but must never advance the high-water cursor past an unprocessed page.
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(762043)');
    const cursor = (await lock.query("SELECT last_signature FROM cursors WHERE source='backfill'")).rows[0]?.last_signature as string | undefined;
    const history: Signature[] = [];
    let before: string | undefined;
    const seen = new Set<string>();
    while (true) {
      const page = await rpc<Signature[]>('getSignaturesForAddress', [PROGRAM_ID, {
        commitment: 'finalized', limit: 1000, ...(before ? { before } : {}), ...(cursor ? { until: cursor } : {}),
      }]);
      if (!page.length) break;
      let reached = false;
      for (const item of page) {
        if (item.signature === cursor) { reached = true; break; }
        if (seen.has(item.signature)) throw new Error('RPC pagination did not advance');
        seen.add(item.signature);
        history.push(item);
      }
      if (reached) break;
      before = page.at(-1)!.signature;
    }
    // Replay oldest first so closed mandates retain identity from their opens.
    for (const item of history.slice().reverse()) {
      const raw = await fetchTransaction(rpc, item.signature);
      if (raw.slot !== item.slot) throw new Error('Transaction slot differs from signature history');
      await ingestTransaction(raw, 'backfill', rpc);
    }
    const newest = history[0];
    if (newest) await lock.query(`INSERT INTO cursors (source, last_slot, last_signature) VALUES ('backfill',$1,$2)
      ON CONFLICT (source) DO UPDATE SET last_slot=EXCLUDED.last_slot, last_signature=EXCLUDED.last_signature`, [String(newest.slot), newest.signature]);
  } finally {
    try { await lock.query('SELECT pg_advisory_unlock(762043)'); } finally { lock.release(); }
  }
}
export async function finalize(rpc: Rpc = createRpc()): Promise<number> {
  const slot = await rpc<number>('getSlot', [{ commitment: 'finalized' }]);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Invalid finalized slot');
  const pending = (await pool.query("SELECT DISTINCT signature FROM decisions WHERE commitment='confirmed' AND slot <= $1", [String(slot)])).rows;
  let count = 0;
  for (let i = 0; i < pending.length; i += 256) {
    const signatures = pending.slice(i, i + 256).map(row => row.signature as string);
    const { value } = await rpc<{ value: ({ slot: number; err: unknown; confirmationStatus: string } | null)[] }>(
      'getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
    count += await transaction(async tx => {
      let changed = 0;
      for (const [index, status] of value.entries()) {
        // A root watermark alone cannot prove a transaction survived a fork.
        if (status?.confirmationStatus !== 'finalized' || status.err != null || status.slot > slot) continue;
        changed += (await tx.query(`UPDATE decisions SET commitment='finalized'
          WHERE signature=$1 AND slot=$2 AND commitment='confirmed'`, [signatures[index], String(status.slot)])).rowCount ?? 0;
      }
      return changed;
    });
  }
  await pool.query(`INSERT INTO cursors (source, finalized_watermark) VALUES ('backfill',$1)
    ON CONFLICT (source) DO UPDATE SET finalized_watermark=GREATEST(cursors.finalized_watermark, EXCLUDED.finalized_watermark)`, [String(slot)]);
  return count;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await backfill(); await finalize(); }
  catch { console.error('Backfill or finalization failed; rerun to resume'); process.exitCode = 1; }
  finally { await pool.end(); }
}
