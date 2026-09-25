import pg from 'pg';
export type Tx = pg.PoolClient;
export const pool = new pg.Pool(); // pg reads PG* environment variables.
export async function transaction<T>(work: (tx: Tx) => Promise<T>, db = pool): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
