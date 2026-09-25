import assert from 'node:assert/strict';
import test from 'node:test';
import { publicRpcFor, redactRpc } from './rpcPrivacy';

test('each supported cluster has a public endpoint', () => {
  for (const cluster of ['devnet', 'testnet', 'mainnet-beta']) {
    assert.equal(publicRpcFor(cluster), `https://api.${cluster}.solana.com`);
  }
  assert.throws(() => publicRpcFor('custom'), /Unsupported/);
});

test('RPC errors retain context but remove credentials and query values', () => {
  for (const url of [
    'https://rpc.example/?api-key=secret',
    'https://rpc.example/?token=secret',
    'https://user:secret@rpc.example/',
    'https://rpc.example/#secret',
    'api-key=secret',
  ]) {
    const result = redactRpc(`Read failed: ${url} unavailable`);
    assert.doesNotMatch(result, /api-key|secret|user/);
    assert.match(result, /\[redacted\]/);
    assert.match(result, /^Read failed: .* unavailable$/);
  }
  assert.equal(redactRpc('https://api.devnet.solana.com'), 'https://api.devnet.solana.com');
});
