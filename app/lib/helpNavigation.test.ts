import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type NavCall = { method: 'push' | 'replace' | 'back'; href?: string };

const calls: NavCall[] = [];
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

mock.module('expo-router', {
  namedExports: {
    usePathname: () => pathname,
    useRouter: () => ({
      push: (href: string) => {
        calls.push({ method: 'push', href });
        history.push(href);
        pathname = href;
      },
      replace: (href: string) => {
        calls.push({ method: 'replace', href });
        if (history.length === 0) history.push(href);
        else history[history.length - 1] = href;
        pathname = href;
      },
      back: () => {
        calls.push({ method: 'back' });
        history.pop();
        pathname = history[history.length - 1] ?? '/';
      },
    }),
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

type HelpScreen = () => ReactNode;
type TopBarComponent = (props: { help?: boolean; back?: string }) => ReactNode;

let HelpIndex: HelpScreen;
let HelpRefusal: HelpScreen;
let HelpExport: HelpScreen;
let TopBar: TopBarComponent;

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
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

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

function at(path: string, stack: string[] = ['/(tabs)/rules', path]): void {
  calls.length = 0;
  history.splice(0, history.length, ...stack);
  pathname = path;
}

test.before(async () => {
  const [index, refusal, exported, bar] = await Promise.all([
    import('../app/help/index'),
    import('../app/help/refusal'),
    import('../app/help/export'),
    import('../components/TopBar'),
  ]);
  HelpIndex = index.default;
  HelpRefusal = refusal.default;
  HelpExport = exported.default;
  TopBar = bar.TopBar;
});

test.beforeEach(() => {
  at('/rules', ['/(tabs)/rules']);
});

test('the three help pages do not show a Help control', async () => {
  const pages: Array<{ path: string; Screen: HelpScreen }> = [
    { path: '/help', Screen: HelpIndex },
    { path: '/help/refusal', Screen: HelpRefusal },
    { path: '/help/export', Screen: HelpExport },
  ];
  for (const page of pages) {
    at(page.path);
    const root = await mount(createElement(page.Screen));
    assert.equal(
      labelsOf(root).includes('Help'),
      false,
      `${page.path} still shows Help, so another press can open /help on top of itself`,
    );
  }
});

test('Help stays hidden on a help or onboarding route when the bar would otherwise show it', async () => {
  for (const path of ['/help', '/help/refusal', '/help/export', '/onboarding']) {
    at(path);
    const root = await mount(createElement(TopBar, { help: true, back: 'Back' }));
    assert.equal(labelsOf(root).includes('Help'), false, `${path} rendered Help`);
  }
});

test('opening help from a help or onboarding route replaces /help', async () => {
  const nav = await import('./helpNavigation');
  for (const path of ['/help', '/help/refusal', '/help/export?from=rules', '/onboarding']) {
    const seen: NavCall[] = [];
    nav.openHelp(
      {
        push: (href: string) => {
          seen.push({ method: 'push', href });
        },
        replace: (href: string) => {
          seen.push({ method: 'replace', href });
        },
      },
      path,
    );
    assert.deepEqual(seen, [{ method: 'replace', href: '/help' }], path);
  }
});

test('Help from another screen pushes one help route', async () => {
  at('/rules', ['/(tabs)/rules']);
  const root = await mount(createElement(TopBar, { help: true }));
  await act(async () => {
    button(root, 'Help').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'push', href: '/help' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help']);
});

test('opening the introduction from help replaces that screen', async () => {
  at('/help');
  const root = await mount(createElement(HelpIndex));
  await act(async () => {
    button(root, 'Show the introduction').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'replace', href: '/onboarding' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/onboarding']);
});

test('next through the help pages replaces the current screen', async () => {
  at('/help');
  const first = await mount(createElement(HelpIndex));
  await act(async () => {
    button(first, 'Next').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'replace', href: '/help/refusal' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help/refusal']);

  at('/help/refusal');
  const second = await mount(createElement(HelpRefusal));
  await act(async () => {
    button(second, 'Next').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'replace', href: '/help/export' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help/export']);
});

test('back on a later help page returns to the previous page without stacking a copy', async () => {
  at('/help/refusal');
  const refusal = await mount(createElement(HelpRefusal));
  await act(async () => {
    button(refusal, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'replace', href: '/help' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help']);

  at('/help/export');
  const exported = await mount(createElement(HelpExport));
  await act(async () => {
    button(exported, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'replace', href: '/help/refusal' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help/refusal']);
});

test('back on the first help page leaves the flow', async () => {
  at('/help');
  const root = await mount(createElement(HelpIndex));
  await act(async () => {
    button(root, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'back' }]);
  assert.deepEqual(history, ['/(tabs)/rules']);
});

test('back from the introduction returns to help without pushing another screen', async () => {
  at('/onboarding');
  const root = await mount(createElement(TopBar, { back: 'Back', help: false }));
  await act(async () => {
    button(root, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'replace', href: '/help' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help']);
});
