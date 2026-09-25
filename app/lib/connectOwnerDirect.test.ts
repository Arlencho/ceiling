import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Keypair } from '@solana/web3.js';
import { act, createElement, useEffect, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ruleRequestHref } from './ruleRequest';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = Keypair.generate().publicKey.toBase58();
const route: { path: string; params: Record<string, string | undefined> } = { path: '/scan', params: {} };
const nav = { pushes: [] as string[], replaces: [] as string[], backs: 0 };
const camera: { permission: { granted: boolean; canAskAgain: boolean } | null } = {
  permission: { granted: true, canAskAgain: true },
};

const COMPANION_LIVE =
  'Your agent can find this rule by itself when it runs the Veto companion. Keep your agent running.';
const COMPANION_SETUP =
  'If your agent runs the Veto companion, it finds this rule by itself. This setup text is for developers.';
const OPEN_THE_RULE = 'Open the rule to copy its setup. The text is on the rule screen.';

const chain = {
  ready: true,
  loading: false,
  error: null as string | null,
  rateLimited: false,
  mandateStatus: 'empty' as string,
  config: {
    rpcUrl: 'http://127.0.0.1:8899',
    programId: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    explorerCluster: 'devnet',
    mintDecimals: 6,
  },
  configError: null as string | null,
  mandate: null as { address: string } | null,
  mandates: [] as { address: string }[],
  decimals: 6,
  submitHeld: false,
  nowMs: Date.now(),
  refresh: async () => undefined,
  open: async () => {
    throw new Error('not used');
  },
};

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

class AnimatedValue {
  constructor(public value: number) {}
  setValue(value: number) {
    this.value = value;
  }
  interpolate() {
    return 0;
  }
  addListener() {
    return 0;
  }
  removeListener() {}
}

const still = {
  start(cb?: (result: { finished: boolean }) => void) {
    cb?.({ finished: true });
  },
  stop() {},
};

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    ActivityIndicator: Host('ActivityIndicator'),
    Animated: {
      Value: AnimatedValue,
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing: () => still,
      delay: () => still,
      sequence: () => still,
      loop: () => still,
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
    Keyboard: {
      dismiss() {},
      addListener: () => ({ remove() {} }),
    },
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
    Text: Host('SvgText'),
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
    useRouter: () => ({
      push(href: string) {
        nav.pushes.push(href);
      },
      replace(href: string) {
        nav.replaces.push(href);
      },
      back() {
        nav.backs += 1;
      },
    }),
    usePathname: () => route.path,
    useLocalSearchParams: () => route.params,
    useFocusEffect(effect: () => void | (() => void)) {
      useEffect(() => effect(), [effect]);
    },
  },
});

mock.module('expo-camera', {
  namedExports: {
    CameraView: Host('CameraView'),
    useCameraPermissions: () => [camera.permission, async () => undefined],
  },
});

mock.module('expo-clipboard', {
  namedExports: {
    getStringAsync: async () => '',
    setStringAsync: async () => undefined,
  },
});

mock.module('expo-constants', {
  defaultExport: { expoConfig: { extra: {} } },
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
    WalletProvider: ({ children }: { children: ReactNode }) => children,
  },
});

mock.module('./useOnboarding', {
  namedExports: {
    useOnboarding: () => ({ ready: true, seen: true, markSeen: async () => undefined }),
    OnboardingProvider: ({ children }: { children: ReactNode }) => children,
  },
});

mock.module('./useRulesets', {
  namedExports: {
    useRulesets: () => ({
      ready: true,
      rulesets: [],
      save: async () => {
        throw new Error('not used');
      },
    }),
  },
});

mock.module('./presignRead', {
  namedExports: {
    observePresign: async () => ({
      configuredCluster: 'devnet',
      genesisHash: null,
      ownerTokenBalance: null,
      cap: 0n,
      decimals: 0,
      mintReadable: false,
      solLamports: null,
      rentAndFeesLamports: 0,
      walletFloorLamports: 0,
      payeeHasTokenAccount: null,
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
          for (const item of child) {
            walk(item);
          }
        }
      };
      walk(node.props.children);
      return bits.join('');
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(root);
  return root;
}

async function unmount(root: ReactTestRenderer): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

async function settle(root: ReactTestRenderer, ready: (text: string) => boolean): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const text = textOf(root);
    if (ready(text)) {
      return text;
    }
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  return textOf(root);
}

function applyHref(href: string): void {
  const queryAt = href.indexOf('?');
  const query = queryAt === -1 ? '' : href.slice(queryAt + 1);
  const params: Record<string, string> = {};
  if (query.length > 0) {
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      const rawValue = eq === -1 ? '' : part.slice(eq + 1);
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    }
  }
  route.path = queryAt === -1 ? href : href.slice(0, queryAt);
  route.params = params;
}

function requestUrl(agent: string): string {
  const payee = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  return `veto://rule-request?v=1&agent=${agent}&payee=${payee}&mint=${mint}&cap=5000000&max=500000&days=30&purpose=${encodeURIComponent('charge the car')}`;
}

function fieldWithValue(root: ReactTestRenderer, value: string): ReactTestInstance | undefined {
  return root.root.findAll((node) => isHost(node, 'TextInput')).find((node) => node.props.value === value);
}

test.beforeEach(async () => {
  nav.pushes.length = 0;
  nav.replaces.length = 0;
  nav.backs = 0;
  route.path = '/scan';
  route.params = {};
  camera.permission = { granted: true, canAskAgain: true };
  chain.loading = false;
  chain.mandate = null;
  chain.mandates = [];
  const handoff = (await import('./scanHandoff')) as {
    takeAddressScan: (target: 'agent' | 'payee') => string | null;
    takeWriteRule?: () => string | null;
  };
  handoff.takeAddressScan('agent');
  handoff.takeAddressScan('payee');
  handoff.takeWriteRule?.();
});

test('scanning a bare agent address from Scan a request opens the rule form with that agent filled in', async () => {
  const agent = Keypair.generate().publicKey.toBase58();
  route.params = { target: 'request' };
  const Scan = (await import('../app/scan')).default;
  const scan = await mount(createElement(Scan));
  assert.match(textOf(scan), /Point the camera at your agent's rule request code/);
  const cameraNode = scan.root.findAll((node) => isHost(node, 'CameraView'))[0];
  assert.ok(cameraNode);
  await act(async () => {
    cameraNode.props.onBarcodeScanned({ data: agent });
  });
  await unmount(scan);

  const href = nav.replaces[0];
  assert.ok(href?.startsWith('/rule/new'), `a bare address should open the rule form, got ${href ?? 'nothing'}`);
  applyHref(href);
  const NewRule = (await import('../app/rule/new')).default;
  const form = await mount(createElement(NewRule));
  const text = await settle(form, (value) => value.includes('Write the rule yourself'));
  assert.match(text, /Write the rule yourself/);
  assert.ok(
    fieldWithValue(form, agent),
    `the agent field should show ${agent}`,
  );
  await unmount(form);
});

test('scanning a rule request still opens that request', async () => {
  const agent = Keypair.generate().publicKey.toBase58();
  const url = requestUrl(agent);
  route.params = { target: 'request' };
  const Scan = (await import('../app/scan')).default;
  const scan = await mount(createElement(Scan));
  const cameraNode = scan.root.findAll((node) => isHost(node, 'CameraView'))[0];
  assert.ok(cameraNode);
  await act(async () => {
    cameraNode.props.onBarcodeScanned({ data: url });
  });
  await unmount(scan);

  assert.equal(nav.replaces[0], ruleRequestHref(url));
  assert.equal(nav.backs, 0);
  applyHref(nav.replaces[0] ?? '');
  const Request = (await import('../app/rule-request')).default;
  const screen = await mount(createElement(Request));
  const text = await settle(screen, (value) => value.includes('charge the car'));
  assert.match(text, /charge the car/);
  assert.doesNotMatch(text, /Write the rule yourself/);
  assert.doesNotMatch(text, /That code is not a rule request/);
  await unmount(screen);
});

test('scanning an address for the agent field fills that field and leaves the rule heading', async () => {
  const agent = Keypair.generate().publicKey.toBase58();
  route.params = { target: 'agent' };
  const Scan = (await import('../app/scan')).default;
  const scan = await mount(createElement(Scan));
  const cameraNode = scan.root.findAll((node) => isHost(node, 'CameraView'))[0];
  assert.ok(cameraNode);
  await act(async () => {
    cameraNode.props.onBarcodeScanned({ data: agent });
  });
  await unmount(scan);

  assert.equal(nav.backs, 1);
  assert.equal(nav.replaces.length, 0);
  route.path = '/rule/new';
  route.params = {};
  const NewRule = (await import('../app/rule/new')).default;
  const form = await mount(createElement(NewRule));
  await settle(form, (value) => value.includes('Charging agent') || value.includes(agent));
  assert.ok(fieldWithValue(form, agent), 'the agent field should receive the scanned address');
  assert.doesNotMatch(textOf(form), /Write the rule yourself/);
  await unmount(form);
});

test('the rule live screen tells the owner to keep the agent running so it can find the rule', async () => {
  chain.mandate = { address: Keypair.generate().publicKey.toBase58() };
  const Setup = (await import('../app/first-run/setup')).default;
  const root = await mount(createElement(Setup));
  const text = textOf(root);
  assert.match(text, /Rule live/);
  assert.ok(text.includes(COMPANION_LIVE), text);
  assert.equal(text.includes(OPEN_THE_RULE), false);
  assert.equal(text.includes('Copy setup text'), false);
  await unmount(root);
});

test('the connect panel says the setup text is for developers and still copies it', async () => {
  const { ConnectAgentPanel } = await import('../components/ConnectAgentPanel');
  const json = '{"mandate":"RuleAddress111"}';
  let copied = '';
  const root = await mount(
    createElement(ConnectAgentPanel, {
      rows: [{ label: 'Mandate', value: 'RuleAddress111' }],
      configJson: json,
      status: null,
      onCopy: (value: string) => {
        copied = value;
      },
    }),
  );
  const text = textOf(root);
  assert.ok(text.includes(COMPANION_SETUP), text);
  assert.match(text, /Copy setup text/);
  const ordered = root.root.findAll(
    (node) => isHost(node, 'Text') || isHost(node, 'Pressable') || isHost(node, 'Image'),
  );
  const sentenceAt = ordered.findIndex((node) => textOfNode(node).includes(COMPANION_SETUP));
  const copyAt = ordered.findIndex((node) => node.props.accessibilityLabel === 'Copy setup text');
  const qrAt = ordered.findIndex((node) => node.props.accessibilityLabel === 'QR code of the agent config');
  assert.ok(sentenceAt >= 0 && copyAt > sentenceAt && qrAt > sentenceAt, 'the developer line should sit above the copy button and the code');
  const button = ordered.find((node) => node.props.accessibilityLabel === 'Copy setup text');
  assert.ok(button);
  button.props.onPress();
  assert.equal(copied, json);
  await unmount(root);
});

function textOfNode(node: ReactTestInstance): string {
  const bits: string[] = [];
  const walk = (child: unknown) => {
    if (typeof child === 'string' || typeof child === 'number') {
      bits.push(String(child));
    } else if (Array.isArray(child)) {
      for (const item of child) {
        walk(item);
      }
    }
  };
  walk(node.props.children);
  return bits.join('');
}
