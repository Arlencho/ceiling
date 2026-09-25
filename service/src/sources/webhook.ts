import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { pool } from '../db/transaction.js';
import type { RpcTransaction } from '../decode/index.js';
import { createRpc, fetchTransaction, ingestTransaction, type Rpc } from './shared.js';

export function createWebhookServer(options: { auth?: string; rpc?: Rpc } = {}) {
  const auth = options.auth ?? process.env.INDEX_WEBHOOK_AUTH;
  if (!auth) throw new Error('INDEX_WEBHOOK_AUTH is required');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(auth);
  const rpc = options.rpc ?? createRpc();
  return createServer(async (request, response) => {
    const supplied = request.headers.authorization ?? '';
    if (!timingSafeEqual(digest(supplied), expected)) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    let batch: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      batch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(batch) || batch.some(item => !item || typeof item !== 'object')) throw new Error('Invalid batch');
    } catch { response.writeHead(400).end(); return; }
    try {
      let inserted = 0;
      const transactions: RpcTransaction[] = [];
      for (const item of batch as Record<string, unknown>[]) {
        // Enhanced transactions omit the program logs needed to decode decisions.
        const raw = typeof item.signature === 'string' ? await fetchTransaction(rpc, item.signature) : item as unknown as RpcTransaction;
        transactions.push(raw);
      }
      // Deliveries may be newest first, including records for closed mandates.
      for (const raw of transactions.sort((a, b) => a.slot - b.slot)) {
        inserted += await ingestTransaction(raw, 'webhook', rpc);
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ inserted }));
    } catch { response.writeHead(503).end('Ingestion failed; retry delivery'); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createWebhookServer();
    server.listen(Number(process.env.PORT ?? 8080));
    server.on('error', () => { console.error('Webhook listener failed'); process.exitCode = 1; });
    const stop = () => server.close(() => { void pool.end(); });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch { console.error('Webhook startup failed; check configuration'); process.exitCode = 1; }
}
