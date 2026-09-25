(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Keypair } from '@solana/web3.js';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { GENESIS_BY_CLUSTER } from './presign';
import { DEVNET_USDC_MINT } from './tokens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = Keypair.generate().publicKey;
const agent = Keypair.generate().publicKey;
const payee = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const openCalls: string[] = [];
const openedUrls: string[] = [];
const copiedText: string[] = [];

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
      timing: () => still,
      delay: () => still,
      sequence: () => still,
      loop: () => still,
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (amount: number) => amount,
      cubic: (amount: number) => amount,
      out: (easing: (amount: number) => number) => easing,
      inOut: (easing: (amount: number) => number) => easing,
      bezier: () => (amount: number) => amount,
    },
    Keyboard: {
      dismiss() {},
      addListener() {
        return { remove() {} };
      },
    },
    KeyboardAvoidingView: Host('KeyboardAvoidingView'),
    Platform: { OS: 'ios' },
    Pressable: Host('Pressable'),
    ScrollView: Host('ScrollView'),
    StyleSheet: { create<T>(styles: T): T { return styles; }, hairlineWidth: 1, absoluteFill: {} },
    Linking: {
      openURL: async (url: string) => {
        openedUrls.push(url);
      },
    },
    Text: Host('Text'),
    TextInput: Host('TextInput'),
    UIManager: { measureLayout() {} },
    View: Host('View'),
    findNodeHandle: () => 1,
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Circle: Host('Circle'),
    Path: Host('Path'),
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

mock.module('expo-constants', {
  defaultExport: { expoConfig: { extra: {} } },
});

mock.module('expo-clipboard', {
  namedExports: {
    setStringAsync: async (value: string) => {
      copiedText.push(value);
      return true;
    },
    getStringAsync: async () => '',
  },
});

mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({ push() {}, replace() {}, back() {} }),
    useFocusEffect: () => undefined,
    usePathname: () => '/first-run/approve',
  },
});

mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async () => null,
      setItem: async () => undefined,
      deleteItem: async () => undefined,
    },
    transact: async () => undefined,
  },
});

mock.module('./addressBook', {
  namedExports: {
    loadAddressBook: async () => ({}),
    saveAddressBook: async () => undefined,
    withSavedName: (book: Record<string, string>, address: string, name: string) => ({
      ...book,
      [address]: name,
    }),
  },
});

const walletStub = {
  ready: true,
  busy: false,
  error: null,
  cluster: 'devnet',
  solanaMobileInstalled: false,
  ownerPublicKey: owner.toBase58(),
  agentPublicKey: null,
  connect: async () => undefined,
  disconnect: async () => undefined,
  signAndSend: async () => [],
  getAgentKeypair: async () => null,
  createAgentKeypair: async () => Keypair.generate(),
};

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => walletStub,
    WalletProvider: ({ children }: { children: ReactNode }) => children,
  },
});

mock.module('./useOnboarding', {
  namedExports: {
    useOnboarding: () => ({ ready: true, seen: true, markSeen: async () => undefined }),
    OnboardingProvider: ({ children }: { children: ReactNode }) => children,
  },
});

const chainStub = {
  ready: true,
  loading: false,
  config: {
    rpcUrl: 'http://127.0.0.1:8899',
    mint: mint.toBase58(),
    explorerCluster: 'devnet',
    programId: Keypair.generate().publicKey.toBase58(),
  },
  configError: null,
  submitHeld: false,
  decimals: 0,
  open: async () => {
    openCalls.push('open');
    throw new Error('You cancelled the wallet request.');
  },
};

mock.module('./useChain', {
  namedExports: {
    useChain: () => chainStub,
    ChainProvider: ({ children }: { children: ReactNode }) => children,
  },
});

const observation = {
  configuredCluster: 'devnet',
  genesisHash: GENESIS_BY_CLUSTER.devnet,
  ownerTokenBalance: 100n,
  cap: 10n,
  decimals: 0,
  mintReadable: true,
  solLamports: 1_000_000_000,
  rentAndFeesLamports: 1_000,
  walletFloorLamports: 1_000,
  payeeHasTokenAccount: true,
};

mock.module('./presignRead', {
  namedExports: {
    observePresign: async () => observation,
  },
});

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
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

function hold(root: ReactTestRenderer): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Pressable')
    .find((candidate) => String(candidate.props.accessibilityLabel).startsWith('Hold to approve rule'));
  assert.ok(node, 'hold button missing');
  return node;
}

test('a cancelled signature arms Hold to approve again', async () => {
  openCalls.length = 0;
  const { ApprovalScreen } = await import('../components/ApprovalScreen');
  const root = await mount(
    createElement(ApprovalScreen, {
      mode: 'request',
      invalidReason: null,
      firstRun: true,
      request: {
        v: 1,
        agent: agent.toBase58(),
        payee: payee.toBase58(),
        mint: mint.toBase58(),
        cap: 10n,
        max: 2n,
        days: 7,
        purpose: 'Charge the car',
        agentLabel: null,
        payeeLabel: null,
      },
    }),
  );
  for (let i = 0; i < 20 && !visibleText(root).includes('Hold to approve rule'); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  assert.match(visibleText(root), /Hold to approve rule/);
  assert.ok(root.root.findAll((node) => node.props.testID === 'approve-hold-0').length >= 1);

  await act(async () => {
    hold(root).props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(visibleText(root), /You cancelled the wallet request/);
  assert.equal(openCalls.length, 1);
  assert.ok(root.root.findAll((node) => node.props.testID === 'approve-hold-1').length >= 1);

  await act(async () => {
    hold(root).props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(openCalls.length, 2, 'a failed signature left Hold to approve disarmed');
});

test('the rule form offers devnet USDC when the wallet is short of the cap', async () => {
  const savedMint = chainStub.config.mint;
  const savedBalance = observation.ownerTokenBalance;
  const savedDecimals = observation.decimals;
  chainStub.config.mint = DEVNET_USDC_MINT;
  observation.ownerTokenBalance = 1n;
  observation.decimals = 6;
  observation.mintReadable = true;
  openedUrls.length = 0;
  copiedText.length = 0;
  try {
    const { ApprovalScreen } = await import('../components/ApprovalScreen');
    const root = await mount(
      createElement(ApprovalScreen, {
        mode: 'template',
        request: null,
        invalidReason: null,
        templateId: 'charging-agent',
      }),
    );
    for (let i = 0; i < 20 && !visibleText(root).includes('Get devnet USDC'); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
    const text = visibleText(root);
    assert.equal(text.split("USDC on devnet is Circle's test token. It has no value.").length - 1, 1);
    assert.match(text, /Get devnet USDC/);
    assert.match(text, /Paste this address into the faucet\. It sends devnet USDC, which has no value\./);
    await act(async () => {
      holdButton(root, 'Copy').props.onPress();
      holdButton(root, 'Get devnet USDC').props.onPress();
    });
    assert.deepEqual(copiedText, [owner.toBase58()]);
    assert.deepEqual(openedUrls, ['https://faucet.circle.com']);
    await act(async () => root.unmount());
  } finally {
    chainStub.config.mint = savedMint;
    observation.ownerTokenBalance = savedBalance;
    observation.decimals = savedDecimals;
  }
});

test('the rule form hides the faucet when the devnet USDC balance covers the cap', async () => {
  const savedMint = chainStub.config.mint;
  const savedBalance = observation.ownerTokenBalance;
  const savedDecimals = observation.decimals;
  chainStub.config.mint = DEVNET_USDC_MINT;
  observation.ownerTokenBalance = 80_000_000n;
  observation.decimals = 6;
  observation.mintReadable = true;
  try {
    const { ApprovalScreen } = await import('../components/ApprovalScreen');
    const root = await mount(
      createElement(ApprovalScreen, {
        mode: 'template',
        request: null,
        invalidReason: null,
        templateId: 'charging-agent',
      }),
    );
    for (let i = 0; i < 20 && !visibleText(root).includes('80 USDC'); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
    const text = visibleText(root);
    assert.match(text, /80 USDC/);
    assert.equal(text.split("USDC on devnet is Circle's test token. It has no value.").length - 1, 1);
    assert.equal(text.includes('Get devnet USDC'), false);
    await act(async () => root.unmount());
  } finally {
    chainStub.config.mint = savedMint;
    observation.ownerTokenBalance = savedBalance;
    observation.decimals = savedDecimals;
  }
});

function holdButton(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Pressable')
    .find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `missing ${label}`);
  return node;
}

test('an invalid request, a missing payee, and a readable request each show their state', async () => {
  const { ApprovalScreen } = await import('../components/ApprovalScreen');
  const invalid = visibleText(
    await mount(
      createElement(ApprovalScreen, {
        mode: 'request',
        request: null,
        invalidReason: 'This is not a rule request.',
      }),
    ),
  );
  assert.match(invalid, /This request is not valid/);

  const empty = await mount(
    createElement(ApprovalScreen, {
      mode: 'template',
      request: null,
      invalidReason: null,
    }),
  );
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  assert.match(visibleText(empty), /Scan or paste the payee address|Your agent asks you for this rule/);
});
