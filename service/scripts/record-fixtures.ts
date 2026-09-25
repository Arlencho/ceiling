#!/usr/bin/env -S npx tsx
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const program = '3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV';
const directory = new URL('../fixtures/devnet/', import.meta.url);
const endpoint = process.env.VETO_RPC || 'https://api.devnet.solana.com';

// Never log transport errors: their messages can contain a credential-bearing URL.
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const body = await response.json() as { result?: T; error?: { code?: number } };
        if (!body.error && body.result !== undefined) return body.result;
        if (typeof body.error?.code === 'number') console.error(`${method}: RPC error code ${body.error.code}`);
      } else { console.error(`${method}: HTTP ${response.status}`); }
    } catch { /* Retry without exposing the endpoint. */ }
    console.error(`${method}: retry ${attempt + 1}/8`);
    await delay(Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw new Error(`${method} failed after 8 attempts`);
}
async function save(name: string, value: unknown) {
  await writeFile(new URL(name, directory), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
async function main() {
  await mkdir(directory, { recursive: true });
  try {
    await readFile(new URL('manifest.json', directory));
    console.log('Fixture capture already complete; leaving recorded data unchanged.');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  type Signature = { signature: string; slot: number; err: unknown; blockTime: number | null };
  // Freeze the account snapshot before paging history so later transactions cannot
  // change the ledger totals being compared. Persist the boundary for resumption.
  type Capture = { accounts: { context: { slot: number }; value: unknown[] }; signatures: Signature[] };
  let capture: Capture;
  try {
    capture = JSON.parse(await readFile(new URL('capture.json', directory), 'utf8')) as Capture;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const accounts = await rpc<Capture['accounts']>('getProgramAccounts', [program, { commitment: 'finalized', encoding: 'base64', withContext: true }]);
    const signatures: Signature[] = [];
    let before: string | undefined;
    while (true) {
      const page = await rpc<Signature[]>('getSignaturesForAddress', [program, { commitment: 'finalized', minContextSlot: accounts.context.slot, limit: 1000, ...(before ? { before } : {}) }]);
      signatures.push(...page.filter(item => item.slot <= accounts.context.slot));
      if (page.length < 1000) break;
      before = page.at(-1)!.signature;
      await delay(3000);
    }
    capture = { accounts, signatures };
    await save('capture.json', capture);
  }
  const { signatures, accounts } = capture;
  if (!signatures.length) throw new Error('No program history returned');
  for (const [index, item] of signatures.entries()) {
    const name = `${item.signature}.json`;
    try { await readFile(new URL(name, directory)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const tx = await rpc<unknown>('getTransaction', [item.signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]);
      if (!tx) throw new Error(`Transaction unavailable: ${item.signature}`);
      await save(name, tx);
      await delay(3000);
    }
    if ((index + 1) % 20 === 0) console.log(`Recorded ${index + 1}/${signatures.length} transactions`);
  }
  try { await save('accounts.json', accounts); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await save('manifest.json', { program, commitment: 'finalized', capturedAt: new Date().toISOString(), signatures });
  await unlink(new URL('capture.json', directory));
  console.log(`Capture complete: ${signatures.length} transactions`);
}
main().catch(() => { console.error('Fixture recording failed; existing captures were preserved.'); process.exitCode = 1; });
