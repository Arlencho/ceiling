import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { decodeTransaction, PROGRAM_ID, type RpcTransaction } from './index.js';
import idl from '../../../indexer/idl/veto.json' with { type: 'json' };
const keys = [PROGRAM_ID, ...Array.from({ length: 7 }, (_, i) => bs58.encode(Buffer.alloc(32, i + 1)))];
function instruction(name: string, args = Buffer.alloc(0)) {
  return { programIdIndex: 0, accounts: [1, 2, 3, 4, 5, 6, 7], data: bs58.encode(Buffer.concat([Buffer.from(idl.instructions.find(i => i.name === name)!.discriminator), args])) };
}
function transaction(ix = instruction('revoke_mandate')): RpcTransaction {
  return { slot: 1, blockTime: 2, transaction: { signatures: ['signature'], message: { accountKeys: keys, instructions: [ix] } }, meta: { err: null, logMessages: [], innerInstructions: [] } };
}
function openArgs() {
  const data = Buffer.alloc(100 + Buffer.byteLength('café'));
  data.writeBigUInt64LE(2n ** 63n, 0);
  Buffer.alloc(32, 8).copy(data, 8);
  Buffer.alloc(32, 9).copy(data, 40);
  data.writeBigUInt64LE(2n ** 63n + 1n, 72);
  data.writeBigUInt64LE(123n, 80);
  data.writeBigInt64LE(-1n, 88);
  data.writeUInt32LE(Buffer.byteLength('café'), 96);
  data.write('café', 100);
  return data;
}
test('open mandate returns exact keys, wide integers, signed expiry and UTF-8 purpose', () => {
  const [record] = decodeTransaction(transaction(instruction('open_mandate', openArgs())));
  assert.equal(record.kind, 'open_mandate');
  if (record.kind !== 'open_mandate') return;
  assert.equal(record.owner, keys[1]); assert.equal(record.mint, keys[5]);
  assert.equal(record.agent, bs58.encode(Buffer.alloc(32, 8)));
  assert.equal(record.merchant, bs58.encode(Buffer.alloc(32, 9)));
  assert.equal(record.mandate_id, 2n ** 63n);
  assert.equal(record.cap, 2n ** 63n + 1n);
  assert.equal(record.per_tx_max, 123n); assert.equal(record.expires_at, -1n);
  assert.equal(record.purpose, 'café');
});
test('override, revoke and close retain their arguments and account keys', () => {
  const args = Buffer.alloc(16); args.writeBigUInt64LE(99n); args.writeBigUInt64LE(42n, 8);
  const tx = transaction(instruction('grant_override', args));
  tx.transaction.message.instructions.push(instruction('revoke_mandate'), instruction('close_mandate'));
  const records = decodeTransaction(tx);
  assert.deepEqual(records.map(r => r.kind), ['grant_override', 'revoke_mandate', 'close_mandate']);
  assert.equal(records[0].mandate, keys[2]);
  assert.equal(records[0].kind === 'grant_override' && records[0].amount, 99n);
  assert.equal(records[0].kind === 'grant_override' && records[0].nonce, 42n);
});
test('inner instructions resolve versioned loaded keys and preserve their location', () => {
  const tx = transaction();
  tx.transaction.message.instructions = [{ programIdIndex: 1, accounts: [], data: '' }];
  tx.transaction.message.accountKeys = keys.slice(0, 2);
  tx.meta!.loadedAddresses = { writable: keys.slice(2, 5), readonly: keys.slice(5) };
  tx.meta!.innerInstructions = [{ index: 0, instructions: [instruction('close_mandate')] }];
  const [record] = decodeTransaction(tx);
  assert.equal(record.kind, 'close_mandate'); assert.equal(record.mandate, keys[2]);
  assert.equal(record.instructionIndex, 0); assert.equal(record.innerInstructionIndex, 0);
});
test('failed transactions and foreign program discriminators produce no records', () => {
  const tx = transaction(); tx.meta!.err = { InstructionError: [0, 'error'] };
  assert.deepEqual(decodeTransaction(tx), []);
  tx.meta!.err = null; tx.transaction.message.instructions[0].programIdIndex = 1;
  assert.deepEqual(decodeTransaction(tx), []);
  tx.meta = null; assert.deepEqual(decodeTransaction(tx), []);
});
test('truncated arguments, invalid account indexes and invalid UTF-8 are rejected', () => {
  assert.throws(() => decodeTransaction(transaction(instruction('open_mandate', Buffer.alloc(20)))), /Malformed/);
  const tx = transaction(); tx.transaction.message.instructions[0].accounts[1] = 999;
  assert.throws(() => decodeTransaction(tx), /account index/);
  const args = openArgs(); args[100] = 255;
  assert.throws(() => decodeTransaction(transaction(instruction('open_mandate', args))), /Malformed/);
});

test('multiple charges keep their own counterparties and refusal reasons', () => {
  const args = Buffer.alloc(16); args.writeBigUInt64LE(10n); args.writeBigUInt64LE(1n, 8);
  const first = instruction('charge', args);
  const second = instruction('charge', args); second.accounts[4] = 6;
  const tx = transaction(first); tx.transaction.message.instructions.push(second);
  const paid = Buffer.alloc(64);
  Buffer.from([240, 193, 17, 238, 238, 210, 129, 235]).copy(paid);
  Buffer.from(bs58.decode(keys[2])).copy(paid, 8);
  paid.writeBigUInt64LE(10n, 40); paid.writeBigUInt64LE(1n, 48);
  const refused = Buffer.alloc(65);
  Buffer.from([230, 49, 133, 208, 106, 62, 106, 169]).copy(refused);
  Buffer.from(bs58.decode(keys[2])).copy(refused, 8);
  refused.writeBigUInt64LE(10n, 40); refused.writeBigUInt64LE(1n, 48);
  refused[56] = 3;
  tx.meta!.logMessages = [paid, refused].flatMap(raw => [`Program ${PROGRAM_ID} invoke [1]`, `Program data: ${raw.toString('base64')}`, `Program ${PROGRAM_ID} success`]);
  const records = decodeTransaction(tx);
  assert.deepEqual(records.map(r => r.kind), ['paid', 'refused']);
  assert.equal(records[0].kind === 'paid' && records[0].counterparty, keys[5]);
  assert.equal(records[1].kind === 'refused' && records[1].counterparty, keys[6]);
  assert.equal(records[1].kind === 'refused' && records[1].reason, 3);
  tx.meta!.logMessages = ['Log truncated'];
  assert.throws(() => decodeTransaction(tx), /incomplete charge/);
});
