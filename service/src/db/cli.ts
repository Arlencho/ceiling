import { migrate } from './migrate.js';
import { pool } from './transaction.js';
try {
  await migrate();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
