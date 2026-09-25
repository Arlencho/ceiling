import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Keypair } from '@solana/web3.js';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { act, createElement } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { KIND_PAID, KIND_REFUSED, STATUS_REVOKED } from './constants';
import { barUnits, networkLabel, refusalStreak, ruleDay } from '../components/daily/facts';
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

const owner = Keypair.generate().publicKey.toBase58();
const route: { current: Record<string, string | undefined> } = { current: {} };
const camera: { permission: { granted: boolean; canAskAgain: boolean } | null } = { permission: null };
const rulesetReady = { current: true };
let openCalls = 0;
let closeCalls = 0;

function key(): string {
  return Keypair.generate().publicKey.toBase58();
}

function mandate(partial: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: key(),
    owner,
    agent: key(),
    mint: key(),
    source: key(),
    merchant: key(),
    mandateId: 1n,
    cap: 300n,
    spent: 42n,
    perTxMax: 10n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 84 * 86400),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'garage charger',
    status: 0,
    spendCount: 6,
    refusalCount: 2,
    bump: 1,
    ...partial,
  };
}

const chain = {
  ready: true,
  loading: false,
  error: null as string | null,
  rateLimited: false,
  checkedOwner: owner,
  mandateStatus: 'empty' as 'empty' | 'present' | 'not-read' | 'failed' | 'rate-limited',
  config: {
    rpcUrl: 'http://127.0.0.1',
    programId: key(),
    mint: key(),
    explorerCluster: 'devnet',
    mintDecimals: 0,
  },
  configError: null as string | null,
  mandate: null as MandateAccount | null,
  mandates: [] as MandateAccount[],
  snapshot: null,
  rows: [] as { kind: number; ts: bigint; amount: bigint; counterparty: string; nonce: bigint; suggestedOverride: bigint; kindName: string; reason: number; reasonText: string; signature: string | null }[],
  decimals: 0,
  nowMs: Date.now(),
  genesisHash: null,
  submitHeld: false,
  refresh: async () => undefined,
  selectMandate: async () => undefined,
  open: async () => {
    openCalls += 1;
    throw new Error('The wallet cancelled the request');
  },
  revoke: async () => {
    throw new Error('not used');
  },
  close: async () => {
    closeCalls += 1;
    throw new Error('The wallet cancelled the request');
  },
  probeOverride: async () => {
    throw new Error('not used');
  },
  grantOverride: async () => {
    throw new Error('not used');
  },
};

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    ActivityIndicator: Host('ActivityIndicator'),
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
    Image: Host('Image'),
    Keyboard: { addListener: () => ({ remove() {} }) },
    KeyboardAvoidingView: Host('KeyboardAvoidingView'),
    Linking: { openURL: async () => undefined },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: { OS: 'ios', select: (spec: { ios?: unknown }) => spec.ios },
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
    UIManager: {
      measureLayout: (_node: number, _relative: number, _fail: () => void, ok: (x: number, y: number) => void) => ok(0, 0),
    },
    View: Host('View'),
    findNodeHandle: () => 1,
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Path: Host('Path'),
    Circle: Host('Circle'),
    Rect: Host('Rect'),
    G: Host('G'),
    Defs: Host('Defs'),
    LinearGradient: Host('LinearGradient'),
    Stop: Host('Stop'),
  },
});

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({ push() {}, replace() {}, back() {} }),
    usePathname: () => '/',
    useLocalSearchParams: () => route.current,
    useFocusEffect(effect: () => void | (() => void)) {
      useEffect(() => effect(), [effect]);
    },
  },
});

mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async () => null,
      setItem: async () => undefined,
      deleteItem: async () => undefined,
    },
    transact: async () => {
      throw new Error('no wallet');
    },
  },
});

mock.module('expo-clipboard', {
  namedExports: {
    getStringAsync: async () => '',
    setStringAsync: async () => undefined,
  },
});

mock.module('expo-camera', {
  namedExports: {
    CameraView: Host('CameraView'),
    useCameraPermissions: () => [camera.permission, async () => undefined],
  },
});

mock.module('./useChain', {
  namedExports: {
    useChain: () => chain,
    ChainProvider: ({ children }: { children: ReactNode }) => children,
  },
});

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      busy: false,
      error: null,
      cluster: 'devnet',
      solanaMobileInstalled: false,
      ownerPublicKey: owner,
      agentPublicKey: null,
      connect: async () => undefined,
      disconnect: async () => undefined,
      signAndSend: async () => [],
      getAgentKeypair: async () => null,
      createAgentKeypair: async () => {
        throw new Error('no key');
      },
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
    useRulesets: () => ({
      ready: rulesetReady.current,
      rulesets: [],
      save: async () => {
        throw new Error('not used');
      },
    }),
  },
});

mock.module('./useNotificationOffer', {
  namedExports: {
    useNotificationOffer: () => ({ show: false, turnOn: async () => undefined }),
  },
});

mock.module('./useNotificationExplanation', {
  namedExports: {
    useNotificationExplanation: () => ({ explanation: null, statusLine: null, onContinue: () => undefined }),
  },
});

mock.module('./chain', {
  namedExports: {
    createClient: () => ({
      connection: {
        getAccountInfo: async () => null,
        getTokenAccountsByOwner: async () => ({ value: [] }),
      },
    }),
    fetchAdvisoryDeclines: async () => [],
    readRuleFunds: async () => ({
      source: 'source',
      balance: 258n,
      kind: 'dedicated',
      closeCreatesAssociated: false,
      decimals: 0,
      otherRule: null,
      tokenProgram: null,
    }),
  },
});

function textOf(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => {
      const bits: string[] = [];
      const walk = (child: unknown) => {
        if (typeof child === 'string' || typeof child === 'number') {
          bits.push(String(child));
        } else if (Array.isArray(child)) {
          for (const item of child) walk(item);
        }
      };
      walk(node.props.children);
      return bits.join('');
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

function byLabel(root: ReactTestRenderer, prefix: string): ReactTestInstance {
  const found = root.root
    .findAll((node) => (node.type as unknown) === 'Pressable')
    .find((node) => String(node.props.accessibilityLabel ?? '').startsWith(prefix));
  assert.ok(found, `missing ${prefix}`);
  return found;
}

test('a refusal streak counts only the newest run, and the day comes from the opened time', () => {
  assert.equal(networkLabel('devnet'), 'Devnet');
  assert.equal(refusalStreak([{ kind: KIND_PAID }, { kind: KIND_REFUSED }, { kind: KIND_REFUSED }]), 2);
  assert.equal(refusalStreak([{ kind: KIND_REFUSED }, { kind: KIND_PAID }]), 0);
  const now = 1_700_000_000n;
  const opened = now - 5n * 86400n;
  const clock = ruleDay(opened, now + 84n * 86400n, now);
  assert.deepEqual(clock, { day: 6, total: 89 });
  assert.deepEqual(barUnits(258n, 300n).remaining > 0, true);
});

test('home reads loading, empty, error, and the chain amounts', async () => {
  const Screen = (await import('../app/(tabs)/index')).default;
  chain.mandateStatus = 'not-read';
  chain.mandate = null;
  chain.mandates = [];
  chain.error = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading the chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'empty';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Open your first rule/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'failed';
  chain.error = 'The RPC refused this read';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /The RPC refused this read/);
  assert.match(textOf(root), /The chain read failed/);
  await act(async () => root.unmount());

  const row = mandate();
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  chain.rows = [
    {
      kind: KIND_REFUSED,
      ts: 1n,
      amount: 14n,
      counterparty: row.merchant,
      nonce: 1n,
      suggestedOverride: 0n,
      kindName: 'refused',
      reason: 5,
      reasonText: 'over per-payment maximum',
      signature: null,
    },
  ];
  root = await mount(createElement(Screen));
  const normal = textOf(root);
  assert.match(normal, /Your agent can still spend/);
  assert.match(normal, /258/);
  assert.match(normal, /of 300/);
  assert.match(normal, /garage charger/);
  assert.doesNotMatch(normal, /Charging agent/);
  await act(async () => root.unmount());
});

test('rules reads loading, empty, error, and a live rule from the chain', async () => {
  const Screen = (await import('../app/(tabs)/rules')).default;
  chain.mandateStatus = 'not-read';
  chain.mandate = null;
  chain.mandates = [];
  chain.error = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading the chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'empty';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Nothing on chain for this owner yet/);
  assert.match(textOf(root), /Scan a request/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'failed';
  chain.error = 'Rules could not be read';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Rules could not be read/);
  await act(async () => root.unmount());

  const row = mandate();
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  root = await mount(createElement(Screen));
  const normal = textOf(root);
  assert.match(normal, /garage charger/);
  assert.match(normal, /258/);
  assert.match(normal, /Write a rule/);
  await act(async () => root.unmount());
});

test('a rule page reads loading, a missing rule, a failed read, and the amounts still in it', async () => {
  const Screen = (await import('../app/rule/[address]')).default;
  const row = mandate();
  route.current = { address: row.address };
  chain.mandateStatus = 'not-read';
  chain.mandate = null;
  chain.mandates = [];
  chain.error = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading the chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'empty';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /This rule is not on chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'failed';
  chain.error = 'This rule could not be read';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /The chain read failed/);
  assert.match(textOf(root), /Pull to retry/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  root = await mount(createElement(Screen));
  const normal = textOf(root);
  assert.match(normal, /Your agent can still spend/);
  assert.match(normal, /258/);
  assert.match(normal, /garage charger/);
  assert.match(normal, /Connect your agent/);
  await act(async () => root.unmount());
});

test('a stopped rule offers close again after a cancelled signature', async () => {
  const Screen = (await import('../app/rule/[address]')).default;
  const row = mandate({ status: STATUS_REVOKED, expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10) });
  route.current = { address: row.address };
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  chain.submitHeld = false;
  closeCalls = 0;
  const root = await mount(createElement(Screen));
  assert.match(textOf(root), /You stopped this rule/);
  const press = () => byLabel(root, 'Close this rule');
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(closeCalls, 2);
  await act(async () => root.unmount());
});

test('scan reads a missing camera, a denied camera, a bad code, and a live camera', async () => {
  const Screen = (await import('../app/scan')).default;
  route.current = { target: 'request' };
  camera.permission = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Checking the camera/);
  await act(async () => root.unmount());

  camera.permission = { granted: false, canAskAgain: true };
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /The camera is off/);
  assert.match(textOf(root), /Allow camera/);
  await act(async () => root.unmount());

  camera.permission = { granted: true, canAskAgain: true };
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Looking for the code/);
  assert.match(textOf(root), /Point the camera at your agent's rule request code/);
  const cameraNode = root.root.findAll((node) => (node.type as unknown) === 'CameraView')[0];
  assert.ok(cameraNode);
  await act(async () => {
    cameraNode.props.onBarcodeScanned({ data: 'not-a-code' });
  });
  assert.match(textOf(root), /That code is not a rule request|not a rule request or an address/);
  await act(async () => root.unmount());
});

test('a new rule shows loading, an empty payee, a failed open, and arms the hold again', async () => {
  const Screen = (await import('../app/rule/new')).default;
  route.current = { ruleset: 'mint-budget' };
  rulesetReady.current = false;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading this phone and the chain/);
  await act(async () => root.unmount());

  rulesetReady.current = true;
  route.current = { ruleset: 'new' };
  chain.submitHeld = false;
  openCalls = 0;
  root = await mount(createElement(Screen));
  const shown = textOf(root);
  assert.match(shown, /Author a ruleset|Hold to approve rule/);
  const payee = root.root
    .findAll((node) => (node.type as unknown) === 'TextInput')
    .find((node) => node.props.accessibilityLabel === 'Payee');
  assert.ok(payee);
  assert.equal(payee.props.value, '');
  await act(async () => {
    payee.props.onChangeText(key());
  });
  const press = () => byLabel(root, 'Hold to approve rule');
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(openCalls, 2);
  assert.match(textOf(root), /cancelled/);
  await act(async () => root.unmount());
});
