// Critic round 1 for PR 203 (feat/connect-agent). Renders the rule screen and
// checks that the Connect your agent block is only offered while the rule can
// still pay. Red on 058a32c for the revoked and expired cases.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { agentChargeConfigJson } from './agentConnect';
import { STATUS_ACTIVE, STATUS_REVOKED } from './constants';
import type { MandateAccount } from './mandate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Path: Host('Path'),
    Circle: Host('Circle'),
    Rect: Host('Rect'),
    G: Host('G'),
    Text: Host('SvgText'),
    Defs: Host('Defs'),
    LinearGradient: Host('LinearGradient'),
    Stop: Host('Stop'),
  },
});

mock.module('react-native', {
  namedExports: {
    ActivityIndicator: Host('ActivityIndicator'),
    Image: Host('Image'),
    Linking: { openURL: async () => undefined },
    Pressable: Host('Pressable'),
    RefreshControl: Host('RefreshControl'),
    ScrollView: Host('ScrollView'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Text: Host('Text'),
    TextInput: Host('TextInput'),
    View: Host('View'),
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
      announceForAccessibility: () => undefined,
    },
    Animated: {
      Value: class {
        setValue() {}
        interpolate() {
          return 0;
        }
      },
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing: () => ({ start() {}, stop() {} }),
      delay: () => ({ start() {}, stop() {} }),
      sequence: () => ({ start() {}, stop() {} }),
      loop: () => ({ start() {}, stop() {} }),
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (ease: (value: number) => number) => ease,
      inOut: (ease: (value: number) => number) => ease,
      bezier: () => (value: number) => value,
    },
  },
});

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

const route = { address: '' };

mock.module('expo-router', {
  namedExports: {
    useLocalSearchParams: () => ({ address: route.address }),
    usePathname: () => '/rule/test',
    useRouter: () => ({
      push: () => undefined,
      back: () => undefined,
      replace: () => undefined,
    }),
    useFocusEffect: () => undefined,
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

const clipboard = { copied: null as string | null };

mock.module('expo-clipboard', {
  namedExports: {
    setStringAsync: async (value: string) => {
      clipboard.copied = value;
    },
  },
});

const owner = Keypair.generate().publicKey;

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      ownerPublicKey: owner.toBase58(),
      busy: false,
      error: null,
      connect: async () => undefined,
      disconnect: async () => undefined,
    }),
  },
});

mock.module('./useOnboarding', {
  namedExports: {
    useOnboarding: () => ({ ready: true, seen: true, markSeen: async () => undefined }),
  },
});

mock.module('./useRulesets', {
  namedExports: {
    useRulesets: () => ({ ready: true, rulesets: [], save: async () => undefined }),
  },
});

mock.module('./useNotificationExplanation', {
  namedExports: {
    useNotificationExplanation: () => ({ explanation: null, statusLine: null, onContinue: () => undefined }),
  },
});

const CONFIG = {
  rpcUrl: 'https://api.devnet.solana.com',
  programId: Keypair.generate().publicKey.toBase58(),
  mint: null,
  explorerCluster: 'devnet',
  mintDecimals: 6,
};

const chainStub = {
  ready: true,
  loading: false,
  error: null,
  rateLimited: false,
  checkedOwner: owner.toBase58(),
  mandateStatus: 'present',
  config: CONFIG,
  configError: null,
  mandate: null as MandateAccount | null,
  mandates: [] as MandateAccount[],
  snapshot: null,
  rows: [],
  decimals: 6,
  nowMs: Date.now(),
  genesisHash: null,
  refresh: async () => undefined,
  selectMandate: async () => undefined,
  open: async () => undefined,
  revoke: async () => undefined,
  close: async () => undefined,
  probeOverride: async () => undefined,
  grantOverride: async () => undefined,
};

mock.module('./useChain', {
  namedExports: {
    useChain: () => chainStub,
    ChainProvider: ({ children }: { children: ReactNode }) => children,
  },
});

/** The mint and the payee's associated account exist; nothing else does. */
function connectionFor(mandate: MandateAccount) {
  const mint = new PublicKey(mandate.mint);
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(mandate.merchant), true, TOKEN_PROGRAM_ID);
  const mintData = new Uint8Array(82);
  mintData[44] = 6;
  const ataData = new Uint8Array(165);
  ataData.set(mint.toBytes(), 0);
  return {
    async getAccountInfo(address: PublicKey) {
      if (address.equals(mint)) {
        return { data: mintData, owner: TOKEN_PROGRAM_ID };
      }
      if (address.equals(ata)) {
        return { data: ataData, owner: TOKEN_PROGRAM_ID };
      }
      return null;
    },
    async getTokenAccountsByOwner() {
      return { value: [] };
    },
  };
}

const funds = { current: null as unknown };

mock.module('./chain', {
  namedExports: {
    createClient: () => ({ connection: connectionFor(chainStub.mandates[0]!) }),
    readRuleFunds: async () => funds.current,
  },
});

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: Keypair.generate().publicKey.toBase58(),
    owner: owner.toBase58(),
    agent: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    source: Keypair.generate().publicKey.toBase58(),
    merchant: Keypair.generate().publicKey.toBase58(),
    mandateId: 7n,
    cap: 300_000_000n,
    spent: 0n,
    perTxMax: 10_000_000n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'critic r1',
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
    ...over,
  };
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

async function settle(root: ReactTestRenderer, done: (text: string) => boolean): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    const text = visibleText(root);
    if (done(text)) {
      return text;
    }
  }
  return visibleText(root);
}

function decodeQr(root: ReactTestRenderer): string | null {
  const images = root.root.findAll((node) => isHost(node, 'Image'));
  if (images.length === 0) {
    return null;
  }
  const uri = images[0]!.props.source.uri as string;
  const bytes = Buffer.from(uri.slice(uri.indexOf('base64,') + 'base64,'.length), 'base64');
  const png = PNG.sync.read(bytes);
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return code ? code.data : null;
}

async function mountRule(m: MandateAccount): Promise<ReactTestRenderer> {
  chainStub.mandate = m;
  chainStub.mandates = [m];
  chainStub.nowMs = Date.now();
  route.address = m.address;
  funds.current = {
    source: m.source,
    balance: 300_000_000n,
    kind: 'dedicated',
    closeCreatesAssociated: false,
    decimals: 6,
    otherRule: null,
  };
  const screen = (await import('../app/rule/[address]')).default;
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(createElement(screen));
  });
  return root as unknown as ReactTestRenderer;
}

async function unmount(root: ReactTestRenderer): Promise<void> {
  await act(async () => {
    root.unmount();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test('critic r1 control: an active rule offers Copy all and a QR of the same block', async () => {
  const m = mandate();
  const root = await mountRule(m);
  const text = await settle(root, (t) => t.includes('Copy setup text'));
  const expected = agentChargeConfigJson({
    mandate: m.address,
    programId: CONFIG.programId,
    mint: m.mint,
    mintDecimals: 6,
    sourceTokenAccount: m.source,
    payeeTokenAccount: getAssociatedTokenAddressSync(
      new PublicKey(m.mint),
      new PublicKey(m.merchant),
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58(),
    agent: m.agent,
    cluster: 'devnet',
    rpcUrl: CONFIG.rpcUrl,
  });
  assert.match(text, /Give your agent its setup/);
  assert.match(text, /Copy setup text/);
  assert.equal(decodeQr(root), expected);
  const button = root.root
    .findAll((node) => isHost(node, 'Pressable'))
    .find((node) => node.props.accessibilityLabel === 'Copy setup text');
  assert.ok(button);
  await act(async () => {
    button.props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(clipboard.copied, expected);
  await unmount(root);
});

test('critic r1: a revoked rule does not hand out an agent block', async () => {
  const m = mandate({ status: STATUS_REVOKED });
  const root = await mountRule(m);
  const text = await settle(root, (t) => t.includes('already revoked on chain') && !t.includes('Reading the mint decimals'));
  assert.match(text, /already revoked on chain/, 'the screen rendered the revoked rule');
  assert.doesNotMatch(text, /Copy setup text/, 'Copy setup text is offered on a revoked rule');
  assert.equal(decodeQr(root), null, 'a QR of the block is drawn for a revoked rule');
  await unmount(root);
});

test('critic r1: an expired rule does not hand out an agent block', async () => {
  const m = mandate({ expiresAt: BigInt(Math.floor(Date.now() / 1000) - 60) });
  const root = await mountRule(m);
  const text = await settle(root, (t) => t.includes('Give your agent its setup') && !t.includes('Reading the mint decimals'));
  assert.match(text, /Give your agent its setup/);
  assert.doesNotMatch(text, /Copy setup text/, 'Copy setup text is offered on an expired rule');
  assert.equal(decodeQr(root), null, 'a QR of the block is drawn for an expired rule');
  await unmount(root);
});
