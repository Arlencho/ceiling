import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodeMintToInstruction, decodeTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { fundingInstruction, USDC_MINT, VTEST_MINT } from '../e2e/funding';

const funder = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const amount = 3_000_000n;

for (const balance of [amount, amount + 1n]) {
  test(`USDC owner receives the required amount from a funder holding ${balance}`, async () => {
    const mint = new PublicKey(USDC_MINT);
    const destination = getAssociatedTokenAddressSync(mint, owner);
    const ix = await fundingInstruction({ mint, destination, funder, amount,
      readBalance: async (address) => {
        assert.equal(address.toBase58(), getAssociatedTokenAddressSync(mint, funder).toBase58());
        return balance;
      },
    });
    const decoded = decodeTransferCheckedInstruction(ix);
    assert.equal(decoded.data.amount, amount);
    assert.equal(decoded.data.decimals, 6);
    assert.equal(decoded.keys.destination.pubkey.toBase58(), destination.toBase58());
    assert.equal(decoded.keys.owner.pubkey.toBase58(), funder.toBase58());
  });
}

for (const balance of [0n, amount - 1n]) {
  test(`USDC funding refuses a balance of ${balance} with the faucet and funder address`, async () => {
    await assert.rejects(fundingInstruction({ mint: new PublicKey(USDC_MINT), destination: owner, funder, amount,
      readBalance: async () => balance,
    }), (error: Error) => {
      assert.ok(error.message.includes('https://faucet.circle.com'));
      assert.ok(error.message.includes(funder.toBase58()));
      assert.ok(error.message.includes('USDC'));
      return true;
    });
  });
}

test('VTEST still mints with the deployer authority without reading its token balance', async () => {
  const mint = new PublicKey(VTEST_MINT);
  const ix = await fundingInstruction({ mint, destination: owner, funder, amount: 5_000_000n,
    readBalance: async () => { throw new Error('VTEST must not need existing tokens'); },
  });
  const decoded = decodeMintToInstruction(ix);
  assert.equal(decoded.data.amount, 5_000_000n);
  assert.equal(decoded.keys.mint.pubkey.toBase58(), VTEST_MINT);
  assert.equal(decoded.keys.authority.pubkey.toBase58(), funder.toBase58());
  assert.equal(decoded.keys.destination.pubkey.toBase58(), owner.toBase58());
});

test('an RPC failure remains an RPC failure rather than a faucet request', async () => {
  await assert.rejects(fundingInstruction({ mint: new PublicKey(USDC_MINT), destination: owner, funder, amount,
    readBalance: async () => { throw new Error('RPC unavailable'); },
  }), /RPC unavailable/);
});
