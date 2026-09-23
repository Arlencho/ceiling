import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Buffer } from 'buffer';
import { Keypair } from '@solana/web3.js';

import {
  AGENT_ADDRESS_HINT,
  agentKeyForOpen,
  copyAgentAddress,
  parseOptionalAgentAddress,
} from './agentAddress';
import {
  AGENT_SECRET_STORE_KEY,
  AGENTS_STORE_KEY,
  createAgentKeypair,
  truncateAddress,
  type WalletStore,
} from './wallet';

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

function memoryStore(): WalletStore {
  const data: Record<string, string> = {};
  return {
    async getItem(key) {
      return data[key] ?? null;
    },
    async setItem(key, value) {
      data[key] = value;
    },
    async deleteItem(key) {
      delete data[key];
    },
  };
}

const HELP =
  "the agent's public address, from wherever the agent runs; leave empty to create one on this phone.";

test('the agent field help text is the one line under the payee', () => {
  assert.equal(AGENT_ADDRESS_HINT, HELP);
});

test('a blank agent address is left empty so this phone creates the key', () => {
  const payee = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey.toBase58();
  for (const text of ['', '   ', '\n']) {
    assert.equal(parseOptionalAgentAddress({ text, owner, payee }), undefined);
  }
});

test('an agent address that is not a base58 public key is refused', () => {
  const payee = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey.toBase58();
  for (const text of ['not-a-key', '123']) {
    assert.throws(
      () => parseOptionalAgentAddress({ text, owner, payee }),
      /agent address must be a base58 public key/,
    );
  }
});

test('an agent address equal to the connected owner is refused', () => {
  const owner = Keypair.generate().publicKey;
  const payee = Keypair.generate().publicKey;
  assert.throws(
    () =>
      parseOptionalAgentAddress({
        text: owner.toBase58(),
        owner: owner.toBase58(),
        payee,
      }),
    /agent address must not be the connected owner/,
  );
});

test('an agent address equal to the payee is refused', () => {
  const owner = Keypair.generate().publicKey;
  const payee = Keypair.generate().publicKey;
  assert.throws(
    () =>
      parseOptionalAgentAddress({
        text: payee.toBase58(),
        owner: owner.toBase58(),
        payee,
      }),
    /agent address must not be the payee/,
  );
});

test('a base58 agent address other than the owner and the payee is accepted', () => {
  const owner = Keypair.generate().publicKey;
  const payee = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const parsed = parseOptionalAgentAddress({
    text: `  ${agent.toBase58()}  `,
    owner: owner.toBase58(),
    payee,
  });
  assert.equal(parsed?.toBase58(), agent.toBase58());
});

test('a filled agent address is refused when no owner is connected', () => {
  const agent = Keypair.generate().publicKey;
  const payee = Keypair.generate().publicKey;
  assert.throws(
    () => parseOptionalAgentAddress({ text: agent.toBase58(), owner: null, payee }),
    /Connect with Seed Vault first/,
  );
});

test('opening with an agent address uses that public key and stores no secret on this phone', async () => {
  const owner = Keypair.generate().publicKey;
  const payee = Keypair.generate().publicKey;
  const given = Keypair.generate().publicKey;
  const parsed = parseOptionalAgentAddress({
    text: given.toBase58(),
    owner: owner.toBase58(),
    payee,
  });
  assert.ok(parsed);
  const store = memoryStore();
  const agent = await agentKeyForOpen(parsed, () => createAgentKeypair(store));
  assert.equal(agent.toBase58(), given.toBase58());
  assert.equal(await store.getItem(AGENT_SECRET_STORE_KEY), null);
  assert.equal(await store.getItem(AGENTS_STORE_KEY), null);
});

test('opening with an empty agent address creates a key on this phone and stores its secret', async () => {
  const payee = Keypair.generate().publicKey;
  const parsed = parseOptionalAgentAddress({
    text: '',
    owner: Keypair.generate().publicKey.toBase58(),
    payee,
  });
  assert.equal(parsed, undefined);
  const store = memoryStore();
  const generated = Keypair.generate();
  const agent = await agentKeyForOpen(parsed, () => createAgentKeypair(store, () => generated));
  assert.equal(agent.toBase58(), generated.publicKey.toBase58());
  const raw = await store.getItem(AGENT_SECRET_STORE_KEY);
  assert.ok(raw);
  const loaded = Keypair.fromSecretKey(Buffer.from(raw, 'base64'));
  assert.equal(loaded.publicKey.toBase58(), generated.publicKey.toBase58());
});

test('copying an agent address writes the full public key', async () => {
  const agent = Keypair.generate().publicKey.toBase58();
  let written = '';
  await copyAgentAddress(agent, async (value) => {
    written = value;
  });
  assert.equal(written, agent);
  assert.notEqual(written, truncateAddress(agent));
});

test('a shortened agent address is not copied', async () => {
  const agent = Keypair.generate().publicKey.toBase58();
  let written = '';
  await assert.rejects(
    () =>
      copyAgentAddress(truncateAddress(agent), async (value) => {
        written = value;
      }),
    /agent address must be a base58 public key/,
  );
  assert.equal(written, '');
});

test('the new rule screen asks for an agent address beside the payee and passes it to open', () => {
  const src = read('../app/rule/new.tsx');
  const payee = src.indexOf('label="Payee"');
  const agent = src.indexOf('label="Agent address"');
  const purpose = src.indexOf('label="Purpose"');
  assert.ok(payee !== -1 && agent !== -1 && purpose !== -1);
  assert.ok(payee < agent && agent < purpose, 'agent address sits with the payee field');
  assert.ok(src.includes('hint={AGENT_ADDRESS_HINT}'));
  assert.ok(src.includes('parseOptionalAgentAddress'));
  assert.match(src, /\.\.\.\(agent \? \{ agent \} : \{\}\)/);
  assert.doesNotMatch(src, /secretKey/);
});

test('open passes a supplied agent address through instead of always minting one', () => {
  const src = read('./useChain.ts');
  assert.match(src, /agentKeyForOpen\(input\.agent/);
  const open = src.slice(src.indexOf('const open = useCallback'));
  assert.match(open, /agent:\s*agentKey/);
});

test('the rule detail screen shows the agent address and copies the full key', () => {
  const src = read('../app/rule/[address].tsx');
  assert.match(src, /copyAgentAddress\(\s*mandate\.agent/);
  assert.match(src, /accessibilityLabel="Copy agent address"/);
  assert.match(src, /\{mandate\.agent\}/);
  assert.doesNotMatch(src, /secretKey/);
});
