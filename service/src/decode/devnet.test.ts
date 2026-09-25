import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import idl from '../../../indexer/idl/veto.json' with { type: 'json' };
import { decodeTransaction, PROGRAM_ID, type RpcTransaction, type ChargeDecision } from './index.js';

const directory = new URL('../../fixtures/devnet/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
const manifest = read('manifest.json') as { program: string; signatures: { signature: string; slot: number }[] };
const transactions = manifest.signatures.slice().reverse().map(s => read(`${s.signature}.json`) as RpcTransaction);
const records = transactions.flatMap(tx => decodeTransaction(tx));
const snapshot = read('accounts.json') as { context: { slot: number }; value: { pubkey: string; account: { owner: string; data: [string, string] } }[] };
const accounts = new Map(snapshot.value.map(a => [a.pubkey, Buffer.from(a.account.data[0], 'base64')]));
const publicKey = (raw: Buffer, offset: number) => new PublicKey(raw.subarray(offset, offset + 32)).toBase58();
const kinds = ['open_mandate', 'paid', 'refused', 'grant_override', 'revoke_mandate'];

test('recorded successful instructions each yield a lifecycle record or a charge decision with reason', () => {
  assert.equal(manifest.program, PROGRAM_ID);
  assert.ok(transactions.length >= 180);
  assert.equal(new Set(manifest.signatures.map(s => s.signature)).size, transactions.length);
  assert.ok(snapshot.context.slot >= Math.max(...transactions.map(tx => tx.slot)));
  for (const tx of transactions) {
    const decoded = decodeTransaction(tx);
    if (tx.meta?.err != null || !tx.meta) { assert.deepEqual(decoded, []); continue; }
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(g => g.instructions)];
    const counts: Record<string, number> = {};
    for (const ix of instructions) {
      if (keys[ix.programIdIndex] !== PROGRAM_ID) continue;
      const disc = Buffer.from(bs58.decode(ix.data)).subarray(0, 8);
      const name = idl.instructions.find(l => disc.equals(Buffer.from(l.discriminator)))?.name;
      if (name) counts[name] = (counts[name] ?? 0) + 1;
    }
    for (const name of ['open_mandate', 'grant_override', 'revoke_mandate', 'close_mandate']) {
      assert.equal(decoded.filter(r => r.kind === name).length, counts[name] ?? 0, `${tx.transaction.signatures[0]} ${name}`);
    }
    const decisions = decoded.filter((r): r is ChargeDecision => r.kind === 'paid' || r.kind === 'refused');
    assert.equal(decisions.length, counts.charge ?? 0, tx.transaction.signatures[0]);
    for (const decision of decisions) {
      assert.equal(decision.kind === 'paid', decision.reason === 0);
      assert.notEqual(decision.reasonText, 'unknown');
    }
  }
  for (const kind of kinds) assert.ok(records.some(r => r.kind === kind), `Fixture lacks ${kind}`);
});

test('every open has owner, agent, mint and exact limits, matching surviving mandate accounts', () => {
  let matched = 0;
  const mandateDisc = Buffer.from(idl.accounts.find(a => a.name === 'Mandate')!.discriminator);
  for (const record of records) {
    if (record.kind !== 'open_mandate') continue;
    for (const key of [record.owner, record.agent, record.mint]) assert.equal(new PublicKey(key).toBase58(), key);
    assert.ok(record.cap > 0n); assert.ok(record.per_tx_max > 0n); assert.ok(record.expires_at > 0n);
    const raw = accounts.get(record.mandate);
    if (!raw) continue; // close_mandate removes the account and its ledger.
    assert.ok(raw.subarray(0, 8).equals(mandateDisc));
    // Mandate identity occupies five public keys, then mandate_id and the limits.
    assert.equal(record.owner, publicKey(raw, 8)); assert.equal(record.agent, publicKey(raw, 40));
    assert.equal(record.mint, publicKey(raw, 72)); assert.equal(record.source, publicKey(raw, 104));
    assert.equal(record.merchant, publicKey(raw, 136));
    assert.equal(record.mandate_id, raw.readBigUInt64LE(168));
    assert.equal(record.cap, raw.readBigUInt64LE(176));
    assert.equal(record.per_tx_max, raw.readBigUInt64LE(192));
    assert.equal(record.expires_at, raw.readBigInt64LE(200));
    matched++;
  }
  assert.ok(matched > 0, 'No surviving mandates verified');
});

test('decoded counts per kind and charge values match every surviving ledger ring', () => {
  let ledgers = 0, entries = 0;
  const discriminator = Buffer.from(idl.accounts.find(a => a.name === 'Ledger')!.discriminator);
  for (const [address, raw] of accounts) {
    if (!raw.subarray(0, 8).equals(discriminator)) continue;
    const mandate = publicKey(raw, 8), total = raw.readUInt32LE(40), head = raw.readUInt16LE(44);
    const history = records.filter(r => r.mandate === mandate && r.kind !== 'close_mandate')
      .sort((a, b) => a.slot - b.slot || a.instructionIndex - b.instructionIndex || (a.innerInstructionIndex ?? -1) - (b.innerInstructionIndex ?? -1));
    assert.equal(history.length, total, `${address} lifetime entries`);
    const recent = history.slice(-32);
    const ledgerCounts = Array(5).fill(0), decodedCounts = Array(5).fill(0);
    for (let i = 0; i < Math.min(total, 32); i++) {
      const offset = 48 + ((total >= 32 ? head + i : i) % 32) * 72;
      const kind = raw[offset + 64], reason = raw[offset + 65];
      const record = recent[i];
      assert.equal(record.kind, kinds[kind], `${address} entry ${i}`);
      ledgerCounts[kind]++; decodedCounts[kinds.indexOf(record.kind)]++;
      if (record.kind === 'paid' || record.kind === 'refused' || record.kind === 'grant_override') {
        assert.equal(record.amount, raw.readBigUInt64LE(offset + 8));
        assert.equal(record.nonce, raw.readBigUInt64LE(offset + 48));
      }
      if (record.kind === 'paid' || record.kind === 'refused') {
        assert.equal(record.reason, reason); assert.equal(record.counterparty, publicKey(raw, offset + 16));
        assert.equal(record.suggestedOverride, raw.readBigUInt64LE(offset + 56));
      }
      entries++;
    }
    assert.deepEqual(decodedCounts, ledgerCounts, address);
    ledgers++;
  }
  assert.ok(ledgers > 0); assert.ok(entries > 0);
});
