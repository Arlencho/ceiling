import pg from 'pg';

// Test files run in parallel processes against the same Postgres service, and
// each truncates the index tables. A per-file database keeps one file's
// truncate from wiping another file's rows mid-test. Call before importing
// src/db/transaction.js so the pool connects to the new database.
export async function useOwnDatabase(name: string): Promise<void> {
  const base = process.env.PGDATABASE ?? 'postgres';
  const admin = new pg.Client({ database: base });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`).catch((error: { code?: string }) => {
      if (error.code !== '42P04') throw error;
    });
  } finally {
    await admin.end();
  }
  process.env.PGDATABASE = name;
}
