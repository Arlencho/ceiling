import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, type Connection, type Transaction } from '@solana/web3.js';
import { CLOSE_TRADE_RULE_DISC, REVOKE_TRADE_RULE_DISC, STATUS_ACTIVE, TRADE_RULE_DISCRIMINATOR } from './constants';
import { decodeTradeRuleAccount, tradeLedgerPda } from './tradeRule';
import { buildCloseTradeInstructions } from './tradeTx';
import type { ChainClient } from './chain';

mock.module('./chain', { namedExports: { confirmSignature: async () => undefined, rentExemptLamports: () => 0 } });
const owner = Keypair.generate().publicKey;
const rule = Keypair.generate().publicKey;
const source = Keypair.generate().publicKey;
const programId = Keypair.generate().publicKey;
const args = { owner, rule, source, programId, inputMint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID,
  status: STATUS_ACTIVE, amount: 0n, decimals: 9, sourceExists: true, ownerAtaExists: false };

for (const action of ['close', 'revoke'] as const) {
  test(`${action} supplies the exact program account order and permissions`, () => {
    const instructions = buildCloseTradeInstructions(args);
    const ix = action === 'close' ? instructions.at(-1)! : instructions[0]!;
    assert.deepEqual(ix.data, Buffer.from(action === 'close' ? CLOSE_TRADE_RULE_DISC : REVOKE_TRADE_RULE_DISC));
    assert.deepEqual(ix.keys, [
      { pubkey: owner, isSigner: true, isWritable: action === 'close' },
      { pubkey: rule, isSigner: false, isWritable: true },
      { pubkey: tradeLedgerPda(programId, rule), isSigner: false, isWritable: true },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ]);
  });
}

for (const delta of [-1, 0, 1]) {
  test(`closing with a missing source ${delta} seconds after expiry respects the expiry boundary`, async () => {
    const now = 2_000_000_000;
    const clock = mock.method(Date, 'now', () => now * 1000);
    try {
      const raw = Buffer.alloc(640);
      Buffer.from(TRADE_RULE_DISCRIMINATOR).copy(raw);
      owner.toBuffer().copy(raw, 8);
      source.toBuffer().copy(raw, 72);
      NATIVE_MINT.toBuffer().copy(raw, 136);
      raw.writeBigInt64LE(BigInt(now - delta), 8 + 13 * 32 + 1 + 9 * 8);
      const live = decodeTradeRuleAccount(rule.toBase58(), raw);
      const mintData = Buffer.alloc(82);
      mintData[44] = 9;
      const client = { programId, connection: {
        getAccountInfo: async (key: typeof rule) => key.equals(rule) ? { data: raw } : key.equals(NATIVE_MINT) ? { data: mintData, owner: TOKEN_PROGRAM_ID } : null,
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      } as unknown as Connection } as ChainClient;
      const { closeTradeRule } = await import('./tradeChain');
      const sent: Transaction[] = [];
      const result = closeTradeRule(client, async (txs) => { sent.push(...txs); return ['closed']; }, owner, live);
      if (delta < 0) {
        await assert.rejects(result, /active rule cannot be closed/);
        assert.equal(sent.length, 0);
      } else {
        assert.deepEqual(await result, { signature: 'closed' });
        assert.equal(sent[0]?.instructions.length, 1);
        assert.deepEqual(sent[0]?.instructions[0]?.data, Buffer.from(CLOSE_TRADE_RULE_DISC));
      }
    } finally { clock.mock.restore(); }
  });
}
