// Critic round 2 fixture for PR 214 (issue 199).
// Walks Help, then "Show the introduction", then back to Help, then back to the
// origin, from every route that renders the Help control, on the stack model of
// helpNavigation.test.ts (push appends, replace swaps the top, back pops). At
// every step inside the flow the system back (a pop) must land on the page the
// on-screen Back names, and the stack must end where it started. Also covers the
// two other ways out of the introduction: Connect and Done.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const history: string[] = [];
let pathname = '/';
let markSeenCalls = 0;
let connectCalls = 0;
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

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

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

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      busy: false,
      error: null,
      ownerPublicKey: owner,
      agentPublicKey: null,
      connect: async () => {
        connectCalls += 1;
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
      markSeen: async () => {
        markSeenCalls += 1;
      },
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
let Onboarding: ScreenComponent;
let TopBar: TopBarComponent;
let helpFlowBackTarget: (pathname: string) => string | null;

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

function start(path: string): void {
  history.splice(0, history.length, path);
  pathname = path;
  markSeenCalls = 0;
  connectCalls = 0;
}

// Every route that renders the TopBar with the Help control, with the props it passes.
const ORIGINS: Array<{ path: string; props: Parameters<TopBarComponent>[0]; source: string }> = [
  { path: '/', props: {}, source: 'app/(tabs)/index.tsx:38' },
  { path: '/rules', props: { title: 'rules', meta: '2 rules' }, source: 'app/(tabs)/rules.tsx:41' },
  { path: '/decisions', props: {}, source: 'app/(tabs)/decisions.tsx:40' },
  { path: '/rule/new', props: { back: 'Rules' }, source: 'app/rule/new.tsx:227' },
  { path: '/rule/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', props: { back: 'Rules', meta: '1 of 2' }, source: 'app/rule/[address].tsx:266' },
  { path: '/decision/5Nf3', props: { back: 'Decisions', meta: 'lunch' }, source: 'app/decision/[id].tsx:92' },
  { path: '/share', props: { back: 'Decisions', meta: 'lunch' }, source: 'app/share.tsx:130' },
];

function assertPopMatchesBack(where: string): void {
  const onScreen = helpFlowBackTarget(pathname);
  assert.equal(onScreen, history[history.length - 2], `${where}: on-screen Back target is not the page under this one`);
}

test.before(async () => {
  const [index, onboarding, bar, nav] = await Promise.all([
    import('../app/help/index'),
    import('../app/onboarding'),
    import('../components/TopBar'),
    import('./helpNavigation'),
  ]);
  HelpIndex = index.default;
  Onboarding = onboarding.default;
  TopBar = bar.TopBar as TopBarComponent;
  helpFlowBackTarget = nav.helpFlowBackTarget;
});

for (const origin of ORIGINS) {
  test(`critic r2: ${origin.source} Help, introduction, Skip, Back returns to ${origin.path}`, async () => {
    owner = null;
    start(origin.path);

    const bar = await mount(createElement(TopBar, origin.props));
    assert.ok(labelsOf(bar).includes('Help'), `${origin.source} renders no Help control`);
    await press(bar, 'Help');
    assert.deepEqual(history, [origin.path, '/help']);

    const help = await mount(createElement(HelpIndex));
    assert.equal(labelsOf(help).includes('Help'), false, '/help renders a Help control');
    await press(help, 'Show the introduction');
    assert.deepEqual(history, [origin.path, '/help', '/onboarding']);
    assertPopMatchesBack('/onboarding');

    const intro = await mount(createElement(Onboarding));
    assert.equal(labelsOf(intro).includes('Help'), false, '/onboarding renders a Help control');
    await press(intro, 'Skip introduction');
    assert.equal(markSeenCalls, 1);
    assert.deepEqual(history, [origin.path, '/help'], 'Skip did not pop to /help');

    const helpAgain = await mount(createElement(HelpIndex));
    await press(helpAgain, 'Back');
    assert.deepEqual(history, [origin.path], 'Back on /help did not return to the origin');
    assert.equal(pathname, origin.path);

    const barAgain = await mount(createElement(TopBar, origin.props));
    assert.deepEqual(labelsOf(barAgain), labelsOf(bar), 'the origin bar changed after the round trip');
  });
}

test('critic r2: the on-screen Back on /onboarding pops to /help like the system back', async () => {
  owner = null;
  start('/rules');
  await press(await mount(createElement(TopBar, { title: 'rules' })), 'Help');
  await press(await mount(createElement(HelpIndex)), 'Show the introduction');
  assert.deepEqual(history, ['/rules', '/help', '/onboarding']);
  const intro = await mount(createElement(Onboarding));
  await press(intro, 'Back');
  assert.deepEqual(history, ['/rules', '/help']);
});

test('critic r2: Connect on the last introduction card returns to /help', async () => {
  owner = null;
  start('/rules');
  await press(await mount(createElement(TopBar, { title: 'rules' })), 'Help');
  await press(await mount(createElement(HelpIndex)), 'Show the introduction');
  const intro = await mount(createElement(Onboarding));
  for (let i = 0; i < 12 && !labelsOf(intro).includes('Connect'); i += 1) {
    await press(intro, 'Next introduction card');
  }
  await press(intro, 'Connect');
  assert.equal(connectCalls, 1);
  assert.equal(markSeenCalls, 1);
  assert.deepEqual(history, ['/rules', '/help'], 'Connect did not pop to /help');
});

test('critic r2: Done on the last introduction card returns to /help for a connected owner', async () => {
  owner = 'OWNER';
  start('/rules');
  await press(await mount(createElement(TopBar, { title: 'rules' })), 'Help');
  await press(await mount(createElement(HelpIndex)), 'Show the introduction');
  const intro = await mount(createElement(Onboarding));
  for (let i = 0; i < 12 && !labelsOf(intro).includes('Done with the introduction'); i += 1) {
    await press(intro, 'Next introduction card');
  }
  assert.equal(labelsOf(intro).includes('Connect'), false, 'a connected owner is offered Connect');
  await press(intro, 'Done with the introduction');
  assert.equal(connectCalls, 0);
  assert.deepEqual(history, ['/rules', '/help'], 'Done did not pop to /help');
  await press(await mount(createElement(HelpIndex)), 'Back');
  assert.deepEqual(history, ['/rules']);
});
