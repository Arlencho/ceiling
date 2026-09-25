// Critic round 1 fixture for PR 220 (issue 215).
// Walks Help, Next, Next, Done from every route that renders the Help control,
// through the introduction detour, and through three Help, Done cycles, on the
// stack model of helpNavigation.test.ts. dismiss(count) follows the vendored
// StackRouter POP (expo-router/build/react-navigation/routers/StackRouter.js:314-330):
// it keeps max(index - count + 1, 1) routes from the bottom and is not handled at
// index 0. The last case is a cold `veto://help/export` link, where the root
// stack holds that route alone.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const history: string[] = [];
let pathname = '/';
let unhandledPops = 0;
let owner: string | null = null;

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

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Path: Host('Path'),
    Circle: Host('Circle'),
    Rect: Host('Rect'),
    G: Host('G'),
    Text: Host('SvgText'),
  },
});

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

function top(): string {
  return history[history.length - 1] ?? '/';
}

function systemBack(): void {
  if (history.length > 1) history.pop();
  pathname = top();
}

mock.module('expo-router', {
  namedExports: {
    usePathname: () => pathname,
    useNavigation: () => ({
      getState: () => ({
        routes: history.map((entry) => ({ name: entry, path: entry })),
      }),
    }),
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
      canDismiss: () => history.length > 1,
      dismiss: (count = 1) => {
        const index = history.length - 1;
        if (index > 0) {
          history.splice(Math.max(index - count + 1, 1));
          pathname = top();
        } else {
          unhandledPops += 1;
        }
      },
      dismissTo: (href: string) => {
        const index = history.lastIndexOf(href);
        if (index >= 0) history.splice(index + 1);
        else history[Math.max(history.length - 1, 0)] = href;
        pathname = top();
      },
      dismissAll: () => {
        history.splice(1);
        pathname = top();
      },
    }),
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      busy: false,
      error: null,
      ownerPublicKey: owner,
      agentPublicKey: null,
      connect: async () => {
        owner = 'OWNER';
      },
      disconnect: async () => undefined,
      signAndSend: async () => [],
      getAgentKeypair: async () => null,
      createAgentKeypair: async () => {
        throw new Error('not used here');
      },
    }),
    WalletProvider: ({ children }: { children: ReactNode }) => children,
  },
});

mock.module('./useOnboarding', {
  namedExports: {
    useOnboarding: () => ({
      ready: true,
      seen: true,
      markSeen: async () => undefined,
    }),
    OnboardingProvider: ({ children }: { children: ReactNode }) => children,
  },
});

type ScreenComponent = () => ReactNode;
type TopBarComponent = (props: {
  title?: string;
  meta?: string;
  back?: string;
  help?: boolean;
}) => ReactNode;

let HelpIndex: ScreenComponent;
let HelpRefusal: ScreenComponent;
let HelpExport: ScreenComponent;
let Onboarding: ScreenComponent;
let TopBar: TopBarComponent;

function pressables(root: ReactTestRenderer): ReactTestInstance[] {
  return root.root.findAll((candidate) => (candidate.type as unknown) === 'Pressable');
}

function labelsOf(root: ReactTestRenderer): string[] {
  return pressables(root).map((node) => String(node.props.accessibilityLabel));
}

function button(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = pressables(root).find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `no button labelled ${label} among ${labelsOf(root).join(', ')}`);
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
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  });
}

// `stack` is the root stack, bottom first. A tab is one root route, labelled by its path.
function start(path: string, stack: string[]): void {
  history.splice(0, history.length, ...stack);
  pathname = path;
  unhandledPops = 0;
}

function helpRoutes(): string[] {
  return history.filter((route) => route === '/help' || route.startsWith('/help/'));
}

async function nextNextDone(): Promise<void> {
  await press(await mount(createElement(HelpIndex)), 'Next');
  await press(await mount(createElement(HelpRefusal)), 'Next');
  assert.equal(pathname, '/help/export');
  await press(await mount(createElement(HelpExport)), 'Done');
}

// Every route that renders the Help control, with the root stack it sits on.
const ORIGINS: Array<{
  path: string;
  stack: string[];
  props: Parameters<TopBarComponent>[0];
  source: string;
}> = [
  { path: '/', stack: ['/'], props: {}, source: 'app/(tabs)/index.tsx:38' },
  { path: '/rules', stack: ['/rules'], props: { title: 'rules', meta: '2 rules' }, source: 'app/(tabs)/rules.tsx:41' },
  { path: '/decisions', stack: ['/decisions'], props: {}, source: 'app/(tabs)/decisions.tsx:40' },
  { path: '/rule/new', stack: ['/rules', '/rule/new'], props: { back: 'Rules' }, source: 'app/rule/new.tsx:227' },
  {
    path: '/rule/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    stack: ['/rules', '/rule/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'],
    props: { back: 'Rules', meta: '1 of 2' },
    source: 'app/rule/[address].tsx:266',
  },
  {
    path: '/decision/5Nf3',
    stack: ['/decisions', '/decision/5Nf3'],
    props: { back: 'Decisions', meta: 'lunch' },
    source: 'app/decision/[id].tsx:92',
  },
  {
    path: '/share',
    stack: ['/decisions', '/decision/5Nf3', '/share'],
    props: { back: 'Decisions', meta: 'lunch' },
    source: 'app/share.tsx:130',
  },
];

test.before(async () => {
  const [index, refusal, exported, onboarding, bar] = await Promise.all([
    import('../app/help/index'),
    import('../app/help/refusal'),
    import('../app/help/export'),
    import('../app/onboarding'),
    import('../components/TopBar'),
  ]);
  HelpIndex = index.default;
  HelpRefusal = refusal.default;
  HelpExport = exported.default;
  Onboarding = onboarding.default;
  TopBar = bar.TopBar as TopBarComponent;
});

for (const origin of ORIGINS) {
  test(`critic r1: ${origin.source} Help, Next, Next, Done returns to ${origin.path} and the system back then leaves help behind`, async () => {
    start(origin.path, origin.stack);
    const bar = await mount(createElement(TopBar, origin.props));
    await press(bar, 'Help');
    assert.deepEqual(history, [...origin.stack, '/help']);

    await nextNextDone();
    assert.deepEqual(history, origin.stack, `${origin.source}: Done did not return to the opener`);
    assert.equal(pathname, origin.path);

    systemBack();
    assert.deepEqual(helpRoutes(), [], `${origin.source}: the system back after Done shows a help page`);
    assert.deepEqual(history, origin.stack.slice(0, Math.max(origin.stack.length - 1, 1)));
  });
}

test('critic r1: the introduction detour does not change what Done dismisses', async () => {
  owner = null;
  start('/rules', ['/rules']);
  await press(await mount(createElement(TopBar, { title: 'rules' })), 'Help');
  await press(await mount(createElement(HelpIndex)), 'Show the introduction');
  assert.deepEqual(history, ['/rules', '/help', '/onboarding']);
  await press(await mount(createElement(Onboarding)), 'Skip to connect wallet');
  assert.deepEqual(history, ['/rules', '/help']);

  await nextNextDone();
  assert.deepEqual(history, ['/rules']);
});

test('critic r1: three Help, Done cycles from a decision leave the stack as it was', async () => {
  const opened = ['/decisions', '/decision/5Nf3'];
  start('/decision/5Nf3', opened);
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await press(await mount(createElement(TopBar, { back: 'Decisions', meta: 'lunch' })), 'Help');
    await nextNextDone();
    assert.deepEqual(history, opened, `cycle ${cycle} left a route behind`);
  }
  systemBack();
  assert.deepEqual(history, ['/decisions']);
});

test('critic r1: Done on a cold veto://help/export link still leaves the help page', async () => {
  // app.json keeps scheme "veto" in production (plugins/withoutDevClientScheme.js drops
  // only exp+ schemes) and app/_layout.tsx sets no initialRouteName, so a cold link
  // seeds the root stack with /help/export alone. A POP at index 0 is not handled.
  start('/help/export', ['/help/export']);
  await press(await mount(createElement(HelpExport)), 'Done');
  assert.equal(unhandledPops, 0, 'Done dispatched a POP the stack router does not handle');
  assert.deepEqual(helpRoutes(), [], `Done left the user on ${pathname}`);
});
