import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';

import { AGENT_ADDRESS_HINT } from './agentAddress';
import {
  AGENT_CHARGE_CONFIG_KEYS,
  AGENT_CONNECT_LINE,
  agentChargeConfig,
  agentChargeConfigJson,
  agentChargeRows,
  agentConnectStatus,
  parseAgentChargeConfig,
  payeeLookup,
  readPayeeTokenAccount,
  type AgentChargeConfig,
  type PayeeLookup,
  type TokenAccountRow,
} from './agentConnect';
import { qrPng } from './qrPng';
import {
  EXPIRY_GUIDANCE,
  LARGEST_PAYMENT_GUIDANCE,
  PAYEE_GUIDANCE,
  TOTAL_CAP_GUIDANCE,
} from './ruleGuidance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

mock.module('react-native', {
  namedExports: {
    Image: Host('Image'),
    Pressable: Host('Pressable'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Text: Host('Text'),
    View: Host('View'),
  },
});

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

function address(): string {
  return Keypair.generate().publicKey.toBase58();
}

function sample(): AgentChargeConfig {
  return agentChargeConfig({
    mandate: address(),
    programId: address(),
    mint: address(),
    mintDecimals: 6,
    sourceTokenAccount: address(),
    payeeTokenAccount: address(),
    agent: address(),
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
  });
}

function documentedShape(): Record<string, unknown> {
  const readme = read('../README.md');
  const heading = readme.indexOf('## Connect an agent');
  assert.notEqual(heading, -1, 'app/README.md documents the agent config');
  const fence = readme.indexOf('```json', heading);
  const end = readme.indexOf('```', fence + 7);
  assert.ok(fence !== -1 && end > fence);
  return JSON.parse(readme.slice(fence + '```json'.length, end)) as Record<string, unknown>;
}

function sdkLoaderExports(): { file: string; name: string }[] {
  const dir = new URL('../../sdk/src/', import.meta.url);
  const found: { file: string; name: string }[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) {
      continue;
    }
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const match of text.matchAll(/export (?:async )?function (loadAgentConfig|parseAgentConfig|loadConfig)\b/g)) {
      const name = match[1];
      if (name) {
        found.push({ file, name });
      }
    }
  }
  return found;
}

function decodePng(bytes: Uint8Array): string {
  const png = PNG.sync.read(Buffer.from(bytes));
  const pixels = new Uint8ClampedArray(png.data);
  const code = jsQR(pixels, png.width, png.height);
  assert.ok(code, 'the QR image did not scan');
  return code.data;
}

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => isHost(node, 'Text'))
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
}

test('the rule screen offers one agent config block to copy and as a QR code', () => {
  const src = read('../app/rule/[address].tsx');
  assert.match(src, /ConnectAgentPanel/);
  assert.match(src, /agentChargeConfigJson\(chargeConfig\)/);
  assert.match(src, /readPayeeTokenAccount/);
  assert.match(src, /isActive\(mandate, nowSec\)/);
  assert.match(src, /agentConnectStatus/);
  assert.match(src, /next\.tokenProgram/);
  assert.match(src, /onCopy=\{\(json\) => \{/);
  assert.equal(
    AGENT_CONNECT_LINE,
    'The agent signs charges with its own key and pays its own small SOL fees; it can never move funds outside this rule.',
  );
  const panel = read('../components/ConnectAgentPanel.tsx');
  assert.match(panel, /Connect your agent/);
  assert.match(panel, /label="Copy all"/);
  assert.match(panel, /<QrCode value=\{configJson\} \/>/);
  assert.match(panel, /\{AGENT_CONNECT_LINE\}/);
});

test('the new rule screen puts a guidance line under payee, largest payment, cap, expiry, and agent', () => {
  const src = read('../app/rule/new.tsx');
  assert.match(src, /hint=\{PAYEE_GUIDANCE\}/);
  assert.match(src, /hint=\{LARGEST_PAYMENT_GUIDANCE\}/);
  assert.match(src, /hint=\{TOTAL_CAP_GUIDANCE\}/);
  assert.match(src, /hint=\{EXPIRY_GUIDANCE\}/);
  assert.match(src, /hint=\{AGENT_ADDRESS_HINT\}/);
  assert.equal(
    PAYEE_GUIDANCE,
    'Who the agent may pay. The program refuses a charge unless the token account it pays is owned by this address.',
  );
  assert.equal(
    LARGEST_PAYMENT_GUIDANCE,
    'The largest single payment. A charge above this is refused unless you allow that one charge, and that allowance cannot raise the total cap.',
  );
  assert.equal(
    TOTAL_CAP_GUIDANCE,
    'The total this rule can pay. A charge that would pass what remains is refused, and allowing one charge cannot raise this total.',
  );
  assert.equal(
    EXPIRY_GUIDANCE,
    'A number of days from now. Open stores that time on chain, and a charge at or after it is refused.',
  );
  assert.equal(
    AGENT_ADDRESS_HINT,
    'The public address of the key your agent signs with, from wherever it runs. Leave it empty only for testing: opening then creates a key on this phone and stores it.',
  );
});

test('the copied config matches the documented shape, and the SDK loader when the package exports one', async () => {
  const documented = documentedShape();
  const config = sample();
  const json = agentChargeConfigJson(config);
  const parsed = parseAgentChargeConfig(JSON.parse(json));
  assert.deepEqual(parsed, config);
  assert.deepEqual(Object.keys(JSON.parse(json) as object), Object.keys(documented));
  assert.deepEqual(Object.keys(documented), [...AGENT_CHARGE_CONFIG_KEYS]);
  for (const key of AGENT_CHARGE_CONFIG_KEYS) {
    assert.equal(typeof (JSON.parse(json) as Record<string, unknown>)[key], typeof documented[key], key);
  }
  assert.equal(parsed.mintDecimals, 6);
  assert.equal(typeof parsed.agent, 'string');
  assert.throws(() => parseAgentChargeConfig([1, 2, 3, 4]), /agent config must be a JSON object/);

  const example = read('../../sdk/examples/pay-once.ts');
  assert.match(example, /JSON\.parse\(readFileSync\(keyFile/);
  assert.match(example, /loadAgentConfig/);
  assert.match(example, /fromConfig/);
  assert.match(example, /<agent-key\.json> <config\.json> <amount>/);

  const loaders = sdkLoaderExports();
  assert.ok(loaders.length > 0, 'the SDK exports a loader for the agent block');
  for (const loader of loaders) {
    const mod = (await import(`../../sdk/src/${loader.file}`)) as Record<string, (value: unknown) => unknown>;
    const fn = mod[loader.name];
    assert.equal(typeof fn, 'function');
    let loaded: unknown;
    try {
      loaded = await fn!(json);
    } catch {
      loaded = await fn!(JSON.parse(json));
    }
    assert.deepEqual(loaded, parsed);
  }
});

test('an inactive rule reports that there is no config to hand an agent', () => {
  const status = agentConnectStatus({
    active: false,
    ready: false,
    decimalsMissing: false,
    payeeProblem: null,
    fundsError: null,
    fundsLoaded: true,
    configProblem: null,
  });
  assert.equal(status, 'This rule is not active, so there is no config to hand an agent.');
  assert.equal(
    agentConnectStatus({
      active: true,
      ready: true,
      decimalsMissing: false,
      payeeProblem: null,
      fundsError: null,
      fundsLoaded: true,
      configProblem: null,
    }),
    null,
  );
});

test('reading the payee with the token program from rule funds asks the mint once', async () => {
  const { readRuleFunds } = await import('./chain');
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const source = await deriveRuleTokenAccount(owner, 85n, TOKEN_PROGRAM_ID);
  const ata = getAssociatedTokenAddressSync(mint, merchant, true, TOKEN_PROGRAM_ID);
  let mintReads = 0;
  const mintData = new Uint8Array(82);
  mintData[44] = 6;
  const connection = {
    async getAccountInfo(address: PublicKey) {
      if (address.equals(mint)) {
        mintReads += 1;
        return { data: mintData, owner: TOKEN_PROGRAM_ID };
      }
      if (address.equals(source) || address.equals(ata)) {
        return { data: accountWithMint(mint), owner: TOKEN_PROGRAM_ID };
      }
      return null;
    },
    async getTokenAccountsByOwner() {
      return { value: [] };
    },
  };
  const funds = await readRuleFunds(
    {
      config: {
        rpcUrl: 'https://api.devnet.solana.com',
        programId: Keypair.generate().publicKey.toBase58(),
        mint: mint.toBase58(),
        explorerCluster: 'devnet',
        mintDecimals: 6,
      },
      connection: connection as never,
      programId: Keypair.generate().publicKey,
    },
    {
      address: Keypair.generate().publicKey.toBase58(),
      owner: owner.toBase58(),
      agent: Keypair.generate().publicKey.toBase58(),
      mint: mint.toBase58(),
      source: source.toBase58(),
      merchant: merchant.toBase58(),
      mandateId: 85n,
      cap: 10n,
      spent: 0n,
      perTxMax: 10n,
      expiresAt: 1n,
      overrideAmount: 0n,
      overrideNonce: 0n,
      lastNonce: 0n,
      purpose: 'once',
      status: 0,
      spendCount: 0,
      refusalCount: 0,
      bump: 1,
    },
  );
  assert.equal(mintReads, 1);
  assert.equal(funds.tokenProgram, TOKEN_PROGRAM_ID.toBase58());
  const payee = await readPayeeTokenAccount(
    payeeLookup(connection),
    merchant,
    mint,
    new PublicKey(funds.tokenProgram),
  );
  assert.equal(payee.toBase58(), ata.toBase58());
  assert.equal(mintReads, 1);
});

test('the app block round-trips through the SDK loader', async () => {
  const loader = sdkLoaderExports().find((item) => item.name === 'loadAgentConfig');
  assert.ok(loader, 'loadAgentConfig is exported');
  const mod = (await import(`../../sdk/src/${loader.file}`)) as {
    loadAgentConfig: (json: string | unknown) => AgentChargeConfig;
  };
  const config = sample();
  const json = agentChargeConfigJson(config);
  assert.deepEqual(mod.loadAgentConfig(json), config);
  assert.deepEqual(mod.loadAgentConfig(JSON.parse(json)), config);
});

test('the QR code is the same JSON Copy all hands to the clipboard', async () => {
  const config = sample();
  const json = agentChargeConfigJson(config);
  assert.equal(decodePng(qrPng(json).bytes), json);

  const { ConnectAgentPanel } = await import('../components/ConnectAgentPanel');
  let copied = '';
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(
      createElement(ConnectAgentPanel, {
        rows: agentChargeRows(config),
        configJson: json,
        status: null,
        onCopy: (value: string) => {
          copied = value;
        },
      }),
    );
  });
  assert.ok(root);
  const shown = root as ReactTestRenderer;
  const text = visibleText(shown);
  assert.match(text, /Connect your agent/);
  assert.match(text, new RegExp(config.mandate));
  assert.match(text, new RegExp(config.payeeTokenAccount));
  assert.match(text, /Copy all/);
  assert.ok(text.includes(AGENT_CONNECT_LINE));
  const image = shown.root.findAll((node) => isHost(node, 'Image'));
  assert.equal(image.length, 1);
  const uri = image[0]?.props.source.uri as string;
  const encoded = uri.slice(uri.indexOf('base64,') + 'base64,'.length);
  assert.equal(decodePng(Buffer.from(encoded, 'base64')), json);
  const button = shown.root
    .findAll((node) => isHost(node, 'Pressable'))
    .find((node) => node.props.accessibilityLabel === 'Copy all');
  assert.ok(button);
  button.props.onPress();
  assert.equal(copied, json);
  await act(async () => {
    shown.unmount();
  });
});

function mintBytes(): Uint8Array {
  return new Uint8Array(45);
}

function accountWithMint(mint: PublicKey): Uint8Array {
  const data = new Uint8Array(165);
  data.set(mint.toBytes(), 0);
  return data;
}

function lookup(args: {
  mint: PublicKey;
  tokenProgram: PublicKey;
  ata: PublicKey;
  ataExists: boolean;
  rows: TokenAccountRow[];
  filters: ({ mint: PublicKey } | { programId: PublicKey })[];
}): PayeeLookup {
  return {
    async getAccountInfo(address) {
      if (address.equals(args.mint)) {
        return { data: mintBytes(), owner: args.tokenProgram };
      }
      if (address.equals(args.ata) && args.ataExists) {
        return { data: accountWithMint(args.mint), owner: args.tokenProgram };
      }
      return null;
    },
    async getTokenAccountsByOwner(_owner, filter) {
      args.filters.push(filter);
      return args.rows;
    },
  };
}

test('the payee token account is the associated account when that account exists', async () => {
  const mint = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, merchant, true, TOKEN_PROGRAM_ID);
  const filters: ({ mint: PublicKey } | { programId: PublicKey })[] = [];
  const payee = await readPayeeTokenAccount(
    lookup({
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      ata,
      ataExists: true,
      rows: [{ pubkey: Keypair.generate().publicKey, data: accountWithMint(mint) }],
      filters,
    }),
    merchant,
    mint,
  );
  assert.equal(payee.toBase58(), ata.toBase58());
  assert.deepEqual(filters, []);
});

test('a payee with no associated account and one token account uses that account', async () => {
  const mint = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, merchant, true, TOKEN_PROGRAM_ID);
  const only = Keypair.generate().publicKey;
  const filters: ({ mint: PublicKey } | { programId: PublicKey })[] = [];
  const payee = await readPayeeTokenAccount(
    lookup({
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      ata,
      ataExists: false,
      rows: [{ pubkey: only, data: accountWithMint(mint) }],
      filters,
    }),
    merchant,
    mint,
  );
  assert.equal(payee.toBase58(), only.toBase58());
  assert.deepEqual(filters, [{ mint }]);
});

test('a token-2022 mint lists by program and still requires the mint', async () => {
  const mint = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, merchant, true, TOKEN_2022_PROGRAM_ID);
  const only = Keypair.generate().publicKey;
  const otherMint = Keypair.generate().publicKey;
  const filters: ({ mint: PublicKey } | { programId: PublicKey })[] = [];
  const payee = await readPayeeTokenAccount(
    lookup({
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      ata,
      ataExists: false,
      rows: [
        { pubkey: Keypair.generate().publicKey, data: accountWithMint(otherMint) },
        { pubkey: only, data: accountWithMint(mint) },
      ],
      filters,
    }),
    merchant,
    mint,
  );
  assert.equal(payee.toBase58(), only.toBase58());
  assert.deepEqual(filters, [{ programId: TOKEN_2022_PROGRAM_ID }]);
});

test('several token accounts and none at all leave the config unpicked', async () => {
  const mint = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, merchant, true, TOKEN_PROGRAM_ID);
  const filters: ({ mint: PublicKey } | { programId: PublicKey })[] = [];
  const base = {
    mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    ata,
    ataExists: false,
    filters,
  };
  await assert.rejects(
    () =>
      readPayeeTokenAccount(
        lookup({
          ...base,
          rows: [
            { pubkey: Keypair.generate().publicKey, data: accountWithMint(mint) },
            { pubkey: Keypair.generate().publicKey, data: accountWithMint(mint) },
          ],
        }),
        merchant,
        mint,
      ),
    /2 token accounts/,
  );
  await assert.rejects(
    () => readPayeeTokenAccount(lookup({ ...base, rows: [] }), merchant, mint),
    /No token account for this payee and mint is on chain/,
  );
  await assert.rejects(
    () =>
      readPayeeTokenAccount(
        {
          async getAccountInfo() {
            return null;
          },
          async getTokenAccountsByOwner() {
            return [];
          },
        },
        merchant,
        mint,
      ),
    /Mint .* was not found on chain/,
  );
});
