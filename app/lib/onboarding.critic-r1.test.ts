// Critic round 1 fixtures for PR 193. Same harness as onboarding.test.ts.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { Keypair } from '@solana/web3.js';
import { act, createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = Keypair.generate();
const memory = new Map<string, string>();
const announced: string[] = [];

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
    AccessibilityInfo: {
      announceForAccessibility: (text: string) => {
        announced.push(text);
      },
      setAccessibilityFocus: () => undefined,
      isScreenReaderEnabled: async () => true,
    },
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
    findNodeHandle: () => 1,
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
    useRouter: () => ({ push: () => undefined, back: () => undefined, replace: () => undefined }),
    useFocusEffect: () => undefined,
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

const secureStore = {
  getItem: async (key: string) => memory.get(key) ?? null,
  setItem: async (key: string, value: string) => {
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
    transact: async (callback: (wallet: unknown) => Promise<unknown>) =>
      callback({
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
      }),
  },
});

// The card and the Connect line say the agent holds none of the owner's money. It still holds SOL for fees.
const CARD_ONE = 'Your agent holds none of your money and cannot move your money on its own.';
const CARD_TWO_TITLE = 'One rule';
const CONNECT_THESIS =
  'The owner key lives in Seed Vault and never leaves it. The agent key holds authority and none of your money.';

type Loaded = {
  ConnectGate: (props: { children: ReactNode }) => ReactNode;
  WalletProvider: (props: { children: ReactNode }) => ReactNode;
  OnboardingProvider: (props: { children: ReactNode }) => ReactNode;
  useWallet: () => { disconnect: () => Promise<void> };
  Text: ComponentType<{ children?: ReactNode }>;
  Pressable: ComponentType<Record<string, unknown>>;
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

function button(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => isHost(candidate, 'Pressable'))
    .find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `no button labelled ${label}`);
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
  assert.fail(`screen did not settle.\n${visibleText(root)}`);
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

// A child of the gate that exposes Disconnect, the same call rules.tsx:149 makes.
function DisconnectChild() {
  const wallet = ui.useWallet();
  return createElement(
    ui.Pressable,
    {
      accessibilityLabel: 'Disconnect',
      onPress: () => {
        void wallet.disconnect();
      },
    },
    createElement(ui.Text, null, 'home'),
  );
}

function gate(child: ReactElement): ReactElement {
  return createElement(
    ui.WalletProvider,
    null,
    createElement(ui.OnboardingProvider, null, createElement(ui.ConnectGate, null, child)),
  );
}

test.before(async () => {
  const [connect, wallet, useWallet, onboarding, rn, flags] = await Promise.all([
    import('../components/ConnectGate'),
    import('./wallet'),
    import('./useWallet'),
    import('./useOnboarding'),
    import('react-native'),
    import('./onboarding'),
  ]);
  ui = {
    ConnectGate: connect.ConnectGate,
    WalletProvider: useWallet.WalletProvider,
    OnboardingProvider: onboarding.OnboardingProvider,
    useWallet: useWallet.useWallet,
    Text: rn.Text,
    Pressable: rn.Pressable as ComponentType<Record<string, unknown>>,
    seenKey: flags.ONBOARDING_SEEN_KEY,
    sessionKey: wallet.SESSION_STORE_KEY,
  };
});

test.beforeEach(() => {
  memory.clear();
  announced.length = 0;
});

// Finding 1. OnboardingCards.tsx:80-86 changes the card above the focused Next button and
// neither announces the new card nor marks the card a live region. TalkBack reads nothing.
// Either fix passes: announceForAccessibility with the new card, or accessibilityLiveRegion
// on the labelled card view.
test('Next introduction card reaches a screen reader', async () => {
  const root = await mount(gate(createElement(ui.Text, null, 'home')));
  await settle(root, (text) => text.includes(CARD_ONE));
  await act(async () => {
    button(root, 'Next introduction card').props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(visibleText(root).includes(CARD_TWO_TITLE), 'card 2 did not render');

  const card = root.root.find(
    (node) =>
      typeof node.props?.accessibilityLabel === 'string' &&
      String(node.props.accessibilityLabel).startsWith('Introduction, 2 of 4.'),
  );
  const live = card.props.accessibilityLiveRegion;
  const spoken = announced.some((text) => text.includes(CARD_TWO_TITLE));
  assert.ok(
    spoken || live === 'polite' || live === 'assertive',
    `card 2 is silent for a screen reader: announced=${JSON.stringify(announced)}, liveRegion=${String(live)}`,
  );
});

// Finding 2. PR 193 body: "An owner who was already connected is not sent through the
// introduction". onboarding.ts:48 decides by connected && seen only, and nothing sets seen
// for an owner restored from a stored session. The moment that owner disconnects
// (rules.tsx:149) the cards come back in front of Connect.
test('a returning owner who disconnects lands on Connect, not the introduction', async () => {
  memory.set(
    ui.sessionKey,
    JSON.stringify({ authToken: 'tok', ownerPublicKey: owner.publicKey.toBase58() }),
  );
  const root = await mount(gate(createElement(DisconnectChild)));
  const home = await settle(root, (text) => text.includes('home'));
  assert.equal(home.includes(CARD_ONE), false);

  await act(async () => {
    button(root, 'Disconnect').props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  const after = await settle(root, (text) => text.includes(CONNECT_THESIS) || text.includes(CARD_ONE));
  assert.equal(
    after.includes(CARD_ONE),
    false,
    'a returning owner was sent through the introduction after disconnecting',
  );
  assert.ok(after.includes(CONNECT_THESIS));
});
