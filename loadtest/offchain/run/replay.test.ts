import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../gen/src/gen.js';
import { decodeTransaction } from '../../../service/src/decode/index.js';
import { rpcTransaction } from './replay.js';

test('generated opens, paid, refused and overrides survive the service RPC decoder', () => {
  const records = generate({ agents: 2, rules: 2, transactions: 100, seed: 42, paid: 60, refused: 30, override: 10 });
  const kinds = new Set<string>();
  for (const { tx, intent } of records) {
    const decoded = decodeTransaction(rpcTransaction(tx));
    assert.equal(decoded.length, 1);
    const row = decoded[0];
    kinds.add(row.kind);
    assert.equal(row.kind, intent.kind === 'open' ? 'open_mandate' : intent.kind === 'override' ? 'grant_override' : intent.kind);
    assert.equal(row.mandate, intent.mandate);
    assert.equal(row.signature, tx.signature);
    if ('nonce' in intent) assert.equal('nonce' in row && row.nonce, intent.nonce);
  }
  assert.deepEqual([...kinds].sort(), ['grant_override', 'open_mandate', 'paid', 'refused']);
});
