// Critic round 1 fixture for PR 214 (issue 199).
// The help pages now move by router.replace, so the only screen under any help
// page is the one help was opened from. The on-screen Back names the previous
// help page (helpNavigation.ts BACK_TARGET), while the system back (Android
// hardware back, iOS swipe) pops the stack: expo-router
// useBackButton.native.js calls navigation.goBack(), and getNavigationAction.js
// keeps REPLACE as REPLACE on a stack navigator. The two back affordances must
// land on the same page. The stack model below is the one the producer's
// helpNavigation.test.ts uses.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const history: string[] = [];
let pathname = '/';

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

// The stack model: push appends, replace swaps the top entry, goBack pops.
function systemBack(): void {
  history.pop();
  pathname = history[history.length - 1] ?? '/';
}

mock.module('expo-router', {
  namedExports: {
    usePathname: () => pathname,
    useRouter: () => ({
      push: (href: string) => {
        history.push(href);
        pathname = href;
      },
      replace: (href: string) => {
        if (history.length === 0) history.push(href);
        else history[history.length - 1] = href;
        pathname = href;
      },
      back: systemBack,
    }),
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

type HelpScreen = () => ReactNode;

let HelpIndex: HelpScreen;
let HelpRefusal: HelpScreen;
let helpFlowBackTarget: (pathname: string) => string | null;

function button(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Pressable')
    .find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `no button labelled ${label}`);
  return node;
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

async function press(root: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    button(root, label).props.onPress();
  });
}

function at(path: string): void {
  history.splice(0, history.length, '/(tabs)/rules', path);
  pathname = path;
}

test.before(async () => {
  const [index, refusal, nav] = await Promise.all([
    import('../app/help/index'),
    import('../app/help/refusal'),
    import('./helpNavigation'),
  ]);
  HelpIndex = index.default;
  HelpRefusal = refusal.default;
  helpFlowBackTarget = nav.helpFlowBackTarget;
});

test('critic r1: system back after Next on page 1 lands where the on-screen Back would', async () => {
  at('/help');
  await press(await mount(createElement(HelpIndex)), 'Next');
  assert.equal(pathname, '/help/refusal');
  const onScreen = helpFlowBackTarget(pathname);
  assert.equal(onScreen, '/help');
  systemBack();
  assert.equal(pathname, onScreen, 'system back left the help flow while Back would show page 1');
});

test('critic r1: system back after Next on page 2 lands where the on-screen Back would', async () => {
  at('/help');
  await press(await mount(createElement(HelpIndex)), 'Next');
  await press(await mount(createElement(HelpRefusal)), 'Next');
  assert.equal(pathname, '/help/export');
  const onScreen = helpFlowBackTarget(pathname);
  assert.equal(onScreen, '/help/refusal');
  systemBack();
  assert.equal(pathname, onScreen, 'system back left the help flow while Back would show page 2');
});

test('critic r1: system back from the introduction returns to help', async () => {
  at('/help');
  await press(await mount(createElement(HelpIndex)), 'Show the introduction');
  assert.equal(pathname, '/onboarding');
  const onScreen = helpFlowBackTarget(pathname);
  assert.equal(onScreen, '/help');
  systemBack();
  assert.equal(pathname, onScreen, 'system back left help while Back would return to it');
});
