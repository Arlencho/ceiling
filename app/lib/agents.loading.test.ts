import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { space } from '../components/theme';

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

class AnimatedValue {
  setValue(_value: number) {}
  interpolate() {
    return 0;
  }
}

const animation = { start() {}, stop() {} };

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
      timing: () => animation,
      sequence: () => animation,
      loop: () => animation,
      delay: () => animation,
    },
    Easing: {
      bezier: () => () => 0,
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (fn: unknown) => fn,
      in: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
    },
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
    View: Host('View'),
  },
});

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Circle: Host('Circle'),
    Path: Host('Path'),
    Svg: Host('Svg'),
  },
});

mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({ push() {}, back() {}, replace() {} }),
  },
});

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      ownerPublicKey: 'owner',
      cluster: 'devnet',
      error: null,
      busy: false,
      solanaMobileInstalled: false,
    }),
  },
});

mock.module('./useOnboarding', {
  namedExports: {
    useOnboarding: () => ({ ready: true, seen: true, markSeen: async () => undefined }),
  },
});

mock.module('../components/agents/useAgentHistories', {
  namedExports: {
    useAgentHistories: () => ({
      status: 'loading',
      error: null,
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      nowSec: 0n,
      liveRules: 0,
      agents: [],
      refreshing: true,
      refresh() {},
      saveName: async () => undefined,
    }),
  },
});

function textOf(node: ReactTestInstance): string {
  const bits: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string' || typeof child === 'number') {
      bits.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        walk(item);
      }
    }
  };
  walk(node.props.children);
  return bits.join('');
}

function textNodes(root: ReactTestRenderer): ReactTestInstance[] {
  return root.root.findAll((node) => (node.type as unknown) === 'Text');
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    const merged: Record<string, unknown> = {};
    for (const item of style) {
      Object.assign(merged, flatStyle(item));
    }
    return merged;
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

function hasScreenInset(node: ReactTestInstance | null): boolean {
  let current: ReactTestInstance | null = node;
  while (current) {
    const style = flatStyle(current.props?.style);
    if (style.paddingHorizontal === space.screen || style.marginHorizontal === space.screen) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

test('while the agents tab is loading the pill says Reading and the devnet and chain lines sit below the header', async () => {
  const { default: AgentsTab } = await import('../app/(tabs)/agents');
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(createElement(AgentsTab) as ReactElement);
  });
  assert.ok(root);
  const nodes = textNodes(root);
  const lines = nodes.map(textOf).filter((line) => line.length > 0);
  const at = (fragment: string) => lines.findIndex((line) => line.includes(fragment));
  const veto = at('Veto');
  const notice = at('This app uses devnet');
  const reading = at('Reading the chain.');
  assert.ok(veto >= 0, lines.join(' | '));
  assert.ok(notice > veto, lines.join(' | '));
  assert.ok(reading > veto, lines.join(' | '));
  assert.equal(lines.filter((line) => line.includes('This app uses devnet')).length, 1);
  assert.equal(lines.filter((line) => line.includes('Reading...')).length, 1);
  assert.equal(lines.some((line) => /no rule live/i.test(line)), false);

  const noticeNode = nodes.find((node) => textOf(node).includes('This app uses devnet'));
  const readingNode = nodes.find((node) => textOf(node).includes('Reading the chain.'));
  assert.ok(noticeNode);
  assert.ok(readingNode);
  assert.equal(hasScreenInset(noticeNode), true);
  assert.equal(hasScreenInset(readingNode), true);
});
