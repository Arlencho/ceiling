import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { Keypair } from '@solana/web3.js';
import { act, createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = Keypair.generate();
const memory = new Map<string, string>();
const nav = { pushes: [] as string[], backs: 0 };
let transactCalls = 0;
let rejectSeenWrite = false;

const chainStub = {
  loading: false,
  configError: null as string | null,
  error: null as string | null,
  mandateStatus: 'empty' as string,
  mandate: null,
  mandates: [] as unknown[],
  rows: [] as unknown[],
  nowMs: 1_700_000_000_000,
  decimals: 6,
  config: null,
  refresh: async () => undefined,
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

mock.module('react-native', {
  namedExports: {
    ActivityIndicator: Host('ActivityIndicator'),
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
      push: (href: string) => {
        nav.pushes.push(href);
      },
      back: () => {
        nav.backs += 1;
      },
      replace: (href: string) => {
        nav.pushes.push(href);
      },
    }),
    useFocusEffect: () => undefined,
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

const secureStore = {
  getItem: async (key: string) => memory.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (rejectSeenWrite && key === 'veto.onboarding.seen') {
      throw new Error('store rejected the write');
    }
    memory.set(key, value);
  },
  deleteItem: async (key: string) => {
    memory.delete(key);
  },
};

mock.module('expo-secure-store', {
  namedExports: {
    getItemAsync: (key: string) => secureStore.getItem(key),
    setItemAsync: (key: string, value: string) => secureStore.setItem(key, value),
    deleteItemAsync: (key: string) => secureStore.deleteItem(key),
  },
});

mock.module('./mwa', {
  cache: true,
  namedExports: {
    secureStore,
    transact: async (callback: (wallet: unknown) => Promise<unknown>) => {
      transactCalls += 1;
      return callback({
        authorize: async () => ({
          accounts: [
            {
              address: Buffer.from(owner.publicKey.toBytes()).toString('base64'),
              publicKey: owner.publicKey.toBytes(),
            },
          ],
          auth_token: 'tok',
        }),
        deauthorize: async () => undefined,
      });
    },
  },
});

mock.module('./useChain', {
  namedExports: {
    useChain: () => chainStub,
    ChainProvider: ({ children }: { children: ReactNode }) => children,
  },
});

const CARD_BODIES = [
  'Your agent holds none of your money and cannot move your money on its own. It can only ask the program to pay inside the rule.',
  'You write one rule: who may be paid, the largest single payment, a total cap, and an expiry. The program enforces those limits.',
  'When it asks for more than the largest single payment, the program does not pay. The chain records why: a transaction that moved nothing, with the reason.',
  'Your phone can tell you, and you decide: allow that one payment above the per-payment ceiling when it stays inside the total cap, or revoke the rule. Anyone can check the record against the chain.',
] as const;

const CONNECT_THESIS =
  'The owner key lives in Seed Vault and never leaves it. The agent key holds authority and none of your money.';

const SEED_VAULT_LINE = 'The owner key stays in Seed Vault. This app never sees it.';

const OPEN_FIRST_RULE_NEXT =
  'You set the payee, the largest single payment, a total cap, and an expiry, then sign with the key in Seed Vault.';

type Loaded = {
  ConnectGate: (props: { children: ReactNode }) => ReactNode;
  WalletProvider: (props: { children: ReactNode }) => ReactNode;
  OnboardingProvider: (props: { children: ReactNode }) => ReactNode;
  Overview: () => ReactNode;
  Help: () => ReactNode;
  OnboardingRoute: () => ReactNode;
  Text: ComponentType<{ children?: ReactNode }>;
  seenKey: string;
  sessionKey: string;
};

let ui: Loaded;

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => isHost(node, 'Text'))
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
}

function labelsOf(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .map((node) => String(node.props.accessibilityLabel));
}

function button(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => isHost(candidate, 'Pressable'))
    .find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `no button labelled ${label}. Labels: ${labelsOf(root).join(' | ')}`);
  return node;
}

async function settle(root: ReactTestRenderer, ready: (text: string) => boolean): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    const text = visibleText(root);
    if (ready(text)) {
      return text;
    }
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  assert.fail(`screen did not settle.\n${visibleText(root)}\nlabels: ${labelsOf(root).join(' | ')}`);
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
    await new Promise((resolve) => setImmediate(resolve));
  });
}

function gate(child = 'home'): ReactElement {
  return createElement(
    ui.WalletProvider,
    null,
    createElement(ui.OnboardingProvider, null, createElement(ui.ConnectGate, null, createElement(ui.Text, null, child))),
  );
}

function rememberOwner(): void {
  memory.set(
    ui.sessionKey,
    JSON.stringify({ authToken: 'tok', ownerPublicKey: owner.publicKey.toBase58() }),
  );
}

test.before(async () => {
  const [connect, wallet, useWallet, onboarding, overview, help, route, rn, flags] = await Promise.all([
    import('../components/ConnectGate'),
    import('./wallet'),
    import('./useWallet'),
    import('./useOnboarding'),
    import('../app/(tabs)/index'),
    import('../app/help/index'),
    import('../app/onboarding'),
    import('react-native'),
    import('./onboarding'),
  ]);
  ui = {
    ConnectGate: connect.ConnectGate,
    WalletProvider: useWallet.WalletProvider,
    OnboardingProvider: onboarding.OnboardingProvider,
    Overview: overview.default,
    Help: help.default,
    OnboardingRoute: route.default,
    Text: rn.Text,
    seenKey: flags.ONBOARDING_SEEN_KEY,
    sessionKey: wallet.SESSION_STORE_KEY,
  };
});

test.beforeEach(() => {
  memory.clear();
  nav.pushes.length = 0;
  nav.backs = 0;
  transactCalls = 0;
  rejectSeenWrite = false;
  chainStub.mandateStatus = 'empty';
  chainStub.error = null;
  chainStub.configError = null;
  chainStub.loading = false;
});

test('leaving the introduction before Skip or Connect shows it again', async () => {
  const first = await mount(gate());
  const opening = await settle(first, (text) => text.includes(CARD_BODIES[0]));
  assert.equal(opening.includes(CARD_BODIES[0]), true);
  assert.equal(opening.includes('no funds'), false);
  assert.equal(opening.includes(CONNECT_THESIS), false);
  assert.equal(memory.get(ui.seenKey), undefined);
  await unmount(first);

  const second = await mount(gate());
  const again = await settle(second, (text) => text.includes(CARD_BODIES[0]));
  assert.match(again, /It can only ask/);
  assert.equal(again.includes(CONNECT_THESIS), false);
  assert.equal(memory.get(ui.seenKey), undefined);
});

test('Skip on every card stores the flag and the next launch shows Connect', async () => {
  const root = await mount(gate());
  await settle(root, (text) => text.includes(CARD_BODIES[0]));

  for (let i = 0; i < CARD_BODIES.length; i += 1) {
    const text = visibleText(root);
    assert.ok(text.includes(CARD_BODIES[i]), `card ${i + 1} copy missing`);
    assert.ok(
      labelsOf(root).some((label) => label.startsWith(`Introduction, ${i + 1} of 4.`)),
      `card ${i + 1} is not labelled`,
    );
    assert.ok(button(root, 'Skip introduction'));
    const texts = root.root.findAll((node) => isHost(node, 'Text'));
    for (const node of texts) {
      assert.notEqual(node.props.allowFontScaling, false);
      assert.notEqual(node.props.maxFontSizeMultiplier, 1);
    }
    if (i < CARD_BODIES.length - 1) {
      await act(async () => {
        button(root, 'Next introduction card').props.onPress();
      });
    }
  }

  assert.ok(visibleText(root).includes(SEED_VAULT_LINE));
  await act(async () => {
    button(root, 'Skip introduction').props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  const after = await settle(root, (text) => text.includes(CONNECT_THESIS));
  assert.equal(after.includes(CARD_BODIES[0]), false);
  assert.equal(after.includes('no funds'), false);
  assert.equal(memory.get(ui.seenKey), '1');
  assert.equal(transactCalls, 0);
  await unmount(root);

  const next = await mount(gate());
  const relaunch = await settle(next, (text) => text.includes(CONNECT_THESIS));
  assert.equal(relaunch.includes('It can only ask'), false);
  assert.ok(button(next, 'Connect'));
});

test('a failed seen-flag write still shows Connect and the next launch asks again', async () => {
  rejectSeenWrite = true;
  const root = await mount(gate());
  await settle(root, (text) => text.includes(CARD_BODIES[0]));
  assert.equal(memory.get(ui.seenKey), undefined);
  await act(async () => {
    button(root, 'Skip introduction').props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  const after = await settle(root, (text) => text.includes(CONNECT_THESIS));
  assert.equal(after.includes(CARD_BODIES[0]), false);
  assert.equal(memory.get(ui.seenKey), undefined);
  assert.equal(transactCalls, 0);
  await unmount(root);

  const next = await mount(gate());
  const again = await settle(next, (text) => text.includes(CARD_BODIES[0]));
  assert.equal(again.includes(CONNECT_THESIS), false);
});

test('Connect on the last card finishes the introduction and connects', async () => {
  const root = await mount(gate('home'));
  await settle(root, (text) => text.includes(CARD_BODIES[0]));
  for (let i = 0; i < CARD_BODIES.length - 1; i += 1) {
    await act(async () => {
      button(root, 'Next introduction card').props.onPress();
    });
  }
  const last = visibleText(root);
  assert.ok(last.includes(CARD_BODIES[3]));
  assert.ok(last.includes(SEED_VAULT_LINE));
  assert.ok(button(root, 'Skip introduction'));
  assert.equal(last.includes(CONNECT_THESIS), false);

  await act(async () => {
    button(root, 'Connect').props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  const home = await settle(root, (text) => text.includes('home'));
  assert.equal(home.includes(CARD_BODIES[3]), false);
  assert.equal(memory.get(ui.seenKey), '1');
  assert.ok(transactCalls >= 1);
  await unmount(root);

  memory.delete(ui.sessionKey);
  const next = await mount(gate('home'));
  const relaunch = await settle(next, (text) => text.includes(CONNECT_THESIS));
  assert.equal(relaunch.includes('It can only ask'), false);
  assert.equal(relaunch.includes('home'), false);
});

test('the home tab with no rule offers Open your first rule', async () => {
  rememberOwner();
  memory.set(ui.seenKey, '1');
  const root = await mount(
    createElement(ui.WalletProvider, null, createElement(ui.OnboardingProvider, null, createElement(ui.Overview))),
  );
  const text = await settle(root, (value) => value.includes('Open your first rule'));
  assert.ok(text.includes(OPEN_FIRST_RULE_NEXT));
  assert.equal(text.includes('Open one on the Rules tab'), false);
  assert.ok(button(root, 'Help'));
  await act(async () => {
    button(root, 'Open your first rule').props.onPress();
  });
  assert.deepEqual(nav.pushes, ['/rule/new']);
});

test('an owner who already connected is not sent through the introduction', async () => {
  rememberOwner();
  const root = await mount(gate('home'));
  const text = await settle(root, (value) => value.includes('home'));
  assert.equal(text.includes(CARD_BODIES[0]), false);
  assert.equal(memory.get(ui.seenKey), '1');
  assert.equal(transactCalls, 0);
});

test('Help can open the introduction again after it was skipped', async () => {
  memory.set(ui.seenKey, '1');
  const help = await mount(createElement(ui.Help));
  await act(async () => {
    button(help, 'Show the introduction').props.onPress();
  });
  assert.deepEqual(nav.pushes, ['/onboarding']);

  const route = await mount(
    createElement(
      ui.WalletProvider,
      null,
      createElement(ui.OnboardingProvider, null, createElement(ui.OnboardingRoute)),
    ),
  );
  const text = await settle(route, (value) => value.includes(CARD_BODIES[0]));
  assert.ok(text.includes(CARD_BODIES[0]));
  assert.equal(labelsOf(route).includes('Help'), false);
  assert.equal(memory.get(ui.seenKey), '1');
});

test('a connected owner can read the introduction again and leave on Done', async () => {
  rememberOwner();
  memory.set(ui.seenKey, '1');
  const route = await mount(
    createElement(
      ui.WalletProvider,
      null,
      createElement(ui.OnboardingProvider, null, createElement(ui.OnboardingRoute)),
    ),
  );
  await settle(route, (value) => value.includes(CARD_BODIES[0]));
  for (let i = 0; i < CARD_BODIES.length - 1; i += 1) {
    await act(async () => {
      button(route, 'Next introduction card').props.onPress();
    });
  }
  for (let i = 0; i < 40 && !labelsOf(route).includes('Done with the introduction'); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  const last = visibleText(route);
  assert.ok(last.includes(SEED_VAULT_LINE));
  assert.ok(button(route, 'Done with the introduction'));
  assert.equal(labelsOf(route).includes('Skip introduction'), false);
  assert.equal(labelsOf(route).includes('Help'), false);
  assert.equal(labelsOf(route).includes('Connect'), false);
  const calls = transactCalls;
  await act(async () => {
    button(route, 'Done with the introduction').props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(nav.backs, 1);
  assert.equal(transactCalls, calls);
  assert.equal(memory.get(ui.seenKey), '1');
});
