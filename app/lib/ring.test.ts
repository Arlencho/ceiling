import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import {
  ENTRY_SIZE,
  KIND_OPENED,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_ACCOUNT_SIZE,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  REASON_OVER_PER_TX_MAX,
} from './constants';
import { attachSignatures, decodeLedgerAccount } from './ring';

function entryBytes(args: {
  ts: bigint;
  amount: bigint;
  counterparty: Uint8Array;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
}): Buffer {
  const raw = Buffer.alloc(ENTRY_SIZE);
  raw.writeBigInt64LE(args.ts, 0);
  raw.writeBigUInt64LE(args.amount, 8);
  Buffer.from(args.counterparty).copy(raw, 16);
  raw.writeBigUInt64LE(args.nonce, 48);
  raw.writeBigUInt64LE(args.suggestedOverride, 56);
  raw[64] = args.kind;
  raw[65] = args.reason;
  return raw;
}

function ledgerBytes(args: {
  mandate: Uint8Array;
  total: number;
  head: number;
  bump: number;
  slots: Array<Buffer | null>;
}): Buffer {
  const data = Buffer.alloc(LEDGER_ACCOUNT_SIZE);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  Buffer.from(args.mandate).copy(data, 8);
  data.writeUInt32LE(args.total, 40);
  data.writeUInt16LE(args.head, 44);
  data[46] = args.bump;
  for (let i = 0; i < LEDGER_CAPACITY; i++) {
    const slot = args.slots[i];
    if (!slot) {
      continue;
    }
    slot.copy(data, 8 + LEDGER_HEADER_SIZE + i * ENTRY_SIZE);
  }
  return data;
}

test('decodes a short ring without inventing wrapped rows', () => {
  const mandate = Keypair.generate().publicKey.toBytes();
  const merchant = Keypair.generate().publicKey.toBytes();
  const dest = Keypair.generate().publicKey.toBytes();
  const opened = entryBytes({
    ts: 100n,
    amount: 100_000_000n,
    counterparty: merchant,
    nonce: 0n,
    suggestedOverride: 0n,
    kind: KIND_OPENED,
    reason: 0,
  });
  const paid = entryBytes({
    ts: 110n,
    amount: 446_000n,
    counterparty: dest,
    nonce: 1n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    reason: 0,
  });
  const refused = entryBytes({
    ts: 120n,
    amount: 519_500n,
    counterparty: dest,
    nonce: 2n,
    suggestedOverride: 519_500n,
    kind: KIND_REFUSED,
    reason: REASON_OVER_PER_TX_MAX,
  });
  const data = ledgerBytes({
    mandate,
    total: 3,
    head: 3,
    bump: 255,
    slots: [opened, paid, refused],
  });
  const ring = decodeLedgerAccount('Ledger1111111111111111111111111111111111111', data);
  assert.equal(ring.total, 3);
  assert.equal(ring.head, 3);
  assert.equal(ring.entries.length, 3);
  assert.equal(ring.entries[0]?.kind, KIND_OPENED);
  assert.equal(ring.entries[0]?.amount, 100_000_000n);
  assert.equal(ring.entries[1]?.kind, KIND_PAID);
  assert.equal(ring.entries[1]?.nonce, 1n);
  assert.equal(ring.entries[2]?.kind, KIND_REFUSED);
  assert.equal(ring.entries[2]?.reason, REASON_OVER_PER_TX_MAX);
  assert.equal(ring.entries[2]?.suggestedOverride, 519_500n);
  assert.equal(ring.entries[2]?.reasonText, 'over per-payment maximum');
});

test('wrapped ring starts at head and does not invent extra rows', () => {
  const mandate = Keypair.generate().publicKey.toBytes();
  const peer = Keypair.generate().publicKey.toBytes();
  const slots: Buffer[] = [];
  for (let i = 0; i < LEDGER_CAPACITY; i++) {
    slots.push(
      entryBytes({
        ts: BigInt(1000 + i),
        amount: BigInt(i + 1),
        counterparty: peer,
        nonce: BigInt(i + 1),
        suggestedOverride: 0n,
        kind: KIND_PAID,
        reason: 0,
      }),
    );
  }
  slots[0] = entryBytes({
    ts: 2000n,
    amount: 99n,
    counterparty: peer,
    nonce: 99n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    reason: 0,
  });
  const data = ledgerBytes({
    mandate,
    total: LEDGER_CAPACITY + 1,
    head: 1,
    bump: 1,
    slots,
  });
  const ring = decodeLedgerAccount('LedgerWrapped11111111111111111111111111111', data);
  assert.equal(ring.entries.length, LEDGER_CAPACITY);
  assert.equal(ring.entries[0]?.nonce, 2n);
  assert.equal(ring.entries[ring.entries.length - 1]?.nonce, 99n);
});

test('attachSignatures matches paid and refused by nonce and amount', () => {
  const peer = Keypair.generate().publicKey.toBase58();
  const entries = [
    {
      ts: 1n,
      amount: 10n,
      counterparty: peer,
      nonce: 1n,
      suggestedOverride: 0n,
      kind: KIND_PAID,
      kindName: 'paid',
      reason: 0,
      reasonText: 'ok',
    },
    {
      ts: 2n,
      amount: 20n,
      counterparty: peer,
      nonce: 2n,
      suggestedOverride: 20n,
      kind: KIND_REFUSED,
      kindName: 'refused',
      reason: REASON_OVER_PER_TX_MAX,
      reasonText: 'over per-payment maximum',
    },
  ];
  const rows = attachSignatures(entries, [
    { signature: 'sig-paid', kind: KIND_PAID, amount: 10n, nonce: 1n, reason: 0 },
    { signature: 'sig-refused', kind: KIND_REFUSED, amount: 20n, nonce: 2n, reason: REASON_OVER_PER_TX_MAX },
  ]);
  assert.equal(rows[0]?.signature, 'sig-paid');
  assert.equal(rows[1]?.signature, 'sig-refused');
});
