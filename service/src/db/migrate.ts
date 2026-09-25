import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { transaction, pool } from './transaction.js';

export async function migrate(db = pool): Promise<void> {
  await transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(762041)');
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await tx.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration changed: ${name}`);
        continue;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    }
  }, db);
}
