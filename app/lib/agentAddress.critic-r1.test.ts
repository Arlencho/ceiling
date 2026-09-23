import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, type Connection, type Transaction } from '@solana/web3.js';

import type { ChainClient } from './chain';
import { parseOptionalAgentAddress } from './agentAddress';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

const ROOT = new URL('..', import.meta.url).pathname;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function key(seed: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, seed));
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) {
    n = n * 256n + BigInt(b);
  }
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) {
      break;
    }
    out = `1${out}`;
  }
  return out;
}

const PROGRAM_ID = key(1);
const TOKEN_PROGRAM = key(2);
const MINT = key(5);

function client(connection: Record<string, unknown>): ChainClient {
  return {
    config: {
      rpcUrl: 'https://api.devnet.solana.com',
      programId: PROGRAM_ID.toBase58(),
      mint: MINT.toBase58(),
      explorerCluster: 'devnet',
      mintDecimals: 6,
    },
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };
}

test('a supplied agent address reaches the open_mandate instruction unchanged, and is not a signer', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const parsed = parseOptionalAgentAddress({
    text: agent.toBase58(),
    owner: owner.toBase58(),
    payee: merchant,
  });
  assert.ok(parsed);

  const source = getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_PROGRAM);
  const connection = {
    getBalance: async () => 50_000_000,
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(MINT)) {
        return { data: Buffer.alloc(0), owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      if (address.equals(source)) {
        return { data: Buffer.alloc(165), owner: TOKEN_PROGRAM, executable: false, lamports: 1 };
      }
      // No mandate PDA exists yet, so the first id is free.
      return null;
    },
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }),
    confirmTransaction: async () => {
      throw new Error('confirm must not be reached in this fixture');
    },
  };

  const signed: Transaction[] = [];
  const stop = new Error('stop before send');
  await assert.rejects(
    () =>
      openMandate(
        client(connection),
        async (txs) => {
          signed.push(...txs);
          throw stop;
        },
        {
          owner,
          agent: parsed,
          merchant,
          cap: 200n,
          perTxMax: 60n,
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
          purpose: 'critic r1 pass-through',
        },
      ),
    (err: unknown) => err === stop,
  );

  assert.equal(signed.length, 1, 'exactly one transaction reaches the wallet prompt');
  const tx = signed[0]!;
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0]!;
  assert.ok(ix.programId.equals(PROGRAM_ID));
  assert.equal(
    Buffer.from(ix.data.subarray(16, 48)).toString('hex'),
    Buffer.from(agent.toBytes()).toString('hex'),
    'the agent bytes in open_mandate data are the ones typed in the field',
  );
  assert.equal(
    Buffer.from(ix.data.subarray(48, 80)).toString('hex'),
    Buffer.from(merchant.toBytes()).toString('hex'),
  );
  assert.ok(
    ix.keys.every((meta) => !meta.pubkey.equals(agent)),
    'the agent is data, not an account, so it never has to sign the open',
  );
  assert.ok(ix.keys[0]!.pubkey.equals(owner) && ix.keys[0]!.isSigner, 'the owner is the only signer');
});

test('the owner key as agent is refused by the chain layer before any RPC and before the wallet prompt', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const rpcCalls: string[] = [];
  const connection = new Proxy(
    {},
    {
      get: (_target, prop) => {
        rpcCalls.push(String(prop));
        return async () => {
          throw new Error(`rpc ${String(prop)} must not be reached`);
        };
      },
    },
  );
  let prompts = 0;
  await assert.rejects(
    () =>
      openMandate(
        client(connection),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        {
          owner,
          agent: owner,
          merchant,
          cap: 200n,
          perTxMax: 60n,
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
          purpose: 'critic r1 owner as agent',
        },
      ),
    /the agent key must not be the owner key/,
  );
  assert.equal(prompts, 0, 'no signing prompt');
  assert.deepEqual(rpcCalls, [], 'no RPC call');
});

test('a base58 string of the wrong byte length is refused as an agent address', () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const payee = Keypair.generate().publicKey;
  for (const length of [31, 33, 64]) {
    const text = base58(Buffer.alloc(length, 7));
    assert.throws(
      () => parseOptionalAgentAddress({ text, owner, payee }),
      /agent address must be a base58 public key/,
      `${length} bytes`,
    );
  }
  // A non-canonical spelling of a real key (a leading 1 that the key does not have) is refused too.
  const real = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () => parseOptionalAgentAddress({ text: `1${real}`, owner, payee }),
    /agent address must be a base58 public key/,
  );
});

test('the owner and payee refusals compare keys, not spellings, so spacing does not slip past them', () => {
  const owner = Keypair.generate().publicKey;
  const payee = Keypair.generate().publicKey;
  assert.throws(
    () =>
      parseOptionalAgentAddress({
        text: `\t${owner.toBase58()}\n`,
        owner: owner.toBase58(),
        payee,
      }),
    /must not be the connected owner/,
  );
  assert.throws(
    () =>
      parseOptionalAgentAddress({
        text: ` ${payee.toBase58()} `,
        owner: owner.toBase58(),
        payee,
      }),
    /must not be the payee/,
  );
});

test('the new rule screen refuses the agent address before it asks the chain to open, and never stores the text', () => {
  const src = read('app/rule/new.tsx');
  const parse = src.indexOf('parseOptionalAgentAddress({');
  const open = src.indexOf('chain.open({');
  assert.ok(parse !== -1 && open !== -1);
  assert.ok(parse < open, 'refusal runs before chain.open, which is where the wallet prompt starts');
  const field = src.slice(src.indexOf('label="Agent address"'), src.indexOf('label="Purpose"'));
  assert.doesNotMatch(field, /editable=\{false\}/, 'the agent field is editable in every compose mode');
  assert.match(field, /onChangeText=\{setAgentAddress\}/);
  assert.doesNotMatch(src, /agentAddress[^\n]*setItem|setItem[^\n]*agentAddress/, 'the typed agent address is not persisted');
  assert.doesNotMatch(src, /agentAddress:/, 'the agent address is not part of a saved ruleset');
});

test('the agent address field is labelled for a screen reader through the shared Field', () => {
  const field = read('components/Field.tsx');
  assert.match(field, /accessibilityLabel=\{accessibilityLabel \?\? label\}/);
  const src = read('app/rule/new.tsx');
  assert.match(src, /<Field\s+label="Agent address"/);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') {
        continue;
      }
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test('an agent secret is only ever touched by wallet.ts and useWallet.ts, and neither can copy or share it', () => {
  const files = ['lib', 'app', 'components'].flatMap((dir) => walk(join(ROOT, dir)));
  assert.ok(files.length > 20, 'the walk found the app sources');
  const secretTokens = /secretKey|fromSecretKey|AGENT_SECRET_STORE_KEY|AGENTS_STORE_KEY|loadAgentKeypair|getAgentKeypair/;
  const allowed = new Set([join(ROOT, 'lib/wallet.ts'), join(ROOT, 'lib/useWallet.ts')]);
  const leaks = files.filter((file) => !allowed.has(file) && secretTokens.test(readFileSync(file, 'utf8')));
  assert.deepEqual(leaks.map((file) => file.replace(ROOT, '')), [], 'no screen, hook or helper reaches an agent secret');
  for (const file of allowed) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /Clipboard|Share\b|expo-sharing|expo-clipboard/, `${file} has no export surface`);
  }
  const helper = read('lib/agentAddress.ts');
  assert.doesNotMatch(helper, /from '\.\/wallet'|Keypair|secure/i, 'the address helper never touches the wallet or a keypair');
});

test('the detail screen copies through a clipboard module that react-native does not warn is leaving core', () => {
  const src = read('app/rule/[address].tsx');
  assert.doesNotMatch(
    src,
    /import \{[^}]*\bClipboard\b[^}]*\} from 'react-native'/,
    "react-native 0.86 index.js:217-224 wraps Clipboard in warnOnce('clipboard-moved'); use expo-clipboard or @react-native-clipboard/clipboard",
  );
});
