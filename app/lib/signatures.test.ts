import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { KIND_REFUSED, REASON_OVER_PER_TX_MAX } from './constants';
import { attachSignatures, type DecodedTxDecision, type RingEntry } from './ring';

function refused(ts: bigint, nonce: bigint, amount: bigint, peer: string): RingEntry {
  return {
    ts,
    amount,
    counterparty: peer,
    nonce,
    suggestedOverride: 0n,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason: REASON_OVER_PER_TX_MAX,
    reasonText: 'over per-payment maximum',
  };
}

test('a retried refusal keeps its own signature and never borrows the other retry\'s', () => {
  const peer = Keypair.generate().publicKey.toBase58();
  // Ring order, oldest first: the same charge refused twice, five minutes apart.
  // A refusal does not advance the nonce, so both rows share nonce and amount.
  const entries = [refused(1_000n, 1n, 5n, peer), refused(1_300n, 1n, 5n, peer)];

  // Exactly what fetchLedgerRows hands over: getSignaturesForAddress returns
  // newest first and chain.ts:340-358 decodes in that order. blockTime is the
  // RPC's own timestamp for each signature.
  const txs = [
    { signature: 'sig-second', kind: KIND_REFUSED, amount: 5n, nonce: 1n, reason: REASON_OVER_PER_TX_MAX, blockTime: 1_300 },
    { signature: 'sig-first', kind: KIND_REFUSED, amount: 5n, nonce: 1n, reason: REASON_OVER_PER_TX_MAX, blockTime: 1_000 },
  ] as Array<DecodedTxDecision & { blockTime: number }>;

  const rows = attachSignatures(entries, txs);
  assert.equal(rows[0]?.ts, 1_000n, 'precondition: rows stay in ring order');
  assert.equal(rows[0]?.signature, 'sig-first', `the older refusal opens ${rows[0]?.signature}`);
  assert.equal(rows[1]?.signature, 'sig-second', `the newer refusal opens ${rows[1]?.signature}`);
});

test('an evicted refusal in the signature window does not attach to a later ring row', () => {
  const peer = Keypair.generate().publicKey.toBase58();
  const entries = [refused(5_000n, 1n, 5n, peer)];
  const txs = [
    { signature: 'sig-evicted', kind: KIND_REFUSED, amount: 5n, nonce: 1n, reason: REASON_OVER_PER_TX_MAX, blockTime: 1_000 },
    { signature: 'sig-live', kind: KIND_REFUSED, amount: 5n, nonce: 1n, reason: REASON_OVER_PER_TX_MAX, blockTime: 5_000 },
  ] as Array<DecodedTxDecision & { blockTime: number }>;

  const rows = attachSignatures(entries, txs);
  assert.equal(rows[0]?.signature, 'sig-live', `the live row opens ${rows[0]?.signature}`);
});
