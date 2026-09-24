// Critic round 2 fixture for PR 220 (issue 215).
// finishHelpExport (lib/helpNavigation.ts:23-29) guards dismiss(HELP_FLOW_DEPTH)
// with router.canDismiss(). The real canDismiss
// (expo-router/build/global-state/router.js:110-124) answers "does a stack hold
// more than one route", not "are the three help routes on the stack". Any entry
// that seeds fewer than three help routes above the opener therefore pops the
// wrong count: POP keeps max(index - count + 1, 1) routes
// (expo-router/build/react-navigation/routers/StackRouter.js:314-330).
// On main Done was router.replace('/(tabs)') and went home from every shape.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const history: string[] = [];
let pathname = '/';
let unhandledPops = 0;

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

function top(): string {
  return history[history.length - 1] ?? '/';
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
      back: () => {
        if (history.length > 1) history.pop();
        else unhandledPops += 1;
        pathname = top();
      },
      // global-state/router.js:110-124: true when a stack holds more than one route.
      canDismiss: () => history.length > 1,
      // StackRouter.js:314-330.
      dismiss: (count = 1) => {
        const index = history.length - 1;
        if (index > 0) {
          history.splice(Math.max(index - count + 1, 1));
          pathname = top();
        } else {
          unhandledPops += 1;
        }
      },
    }),
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

type ScreenComponent = () => ReactNode;

let HelpIndex: ScreenComponent;
let HelpRefusal: ScreenComponent;
let HelpExport: ScreenComponent;

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

async function press(screen: ScreenComponent, label: string): Promise<void> {
  const root = await mount(createElement(screen));
  await act(async () => {
    button(root, label).props.onPress();
  });
}

function start(path: string, stack: string[]): void {
  history.splice(0, history.length, ...stack);
  pathname = path;
  unhandledPops = 0;
}

function helpRoutes(): string[] {
  return history.filter((route) => route === '/help' || route.startsWith('/help/'));
}

test.before(async () => {
  const [index, refusal, exported] = await Promise.all([
    import('../app/help/index'),
    import('../app/help/refusal'),
    import('../app/help/export'),
  ]);
  HelpIndex = index.default;
  HelpRefusal = refusal.default;
  HelpExport = exported.default;
});

test('critic r2: a cold veto://help link, Next, Next, Done leaves the help flow, and a second pass cannot get stuck either', async () => {
  start('/help', ['/help']);
  for (let pass = 1; pass <= 2; pass += 1) {
    await press(HelpIndex, 'Next');
    await press(HelpRefusal, 'Next');
    assert.deepEqual(history, ['/help', '/help/refusal', '/help/export']);
    await press(HelpExport, 'Done');
    assert.equal(unhandledPops, 0, `pass ${pass}: Done dispatched a POP the stack router does not handle`);
    assert.deepEqual(helpRoutes(), [], `pass ${pass}: Done left the user on ${pathname} with nothing under it`);
  }
});

test('critic r2: a cold veto://help/refusal link, Next, Done leaves the help flow', async () => {
  start('/help/refusal', ['/help/refusal']);
  await press(HelpRefusal, 'Next');
  assert.deepEqual(history, ['/help/refusal', '/help/export']);
  await press(HelpExport, 'Done');
  assert.equal(unhandledPops, 0);
  assert.deepEqual(helpRoutes(), [], `Done left the user on ${pathname} with nothing under it`);
});

test('critic r2: a warm veto://help/export link over an open decision keeps that decision on Done', async () => {
  // The app is already open on a decision; the link pushes the export page over it.
  const opened = ['/decisions', '/decision/5Nf3'];
  start('/help/export', [...opened, '/help/export']);
  await press(HelpExport, 'Done');
  assert.deepEqual(helpRoutes(), []);
  assert.deepEqual(history, opened, 'Done popped the decision that was open under the link');
});
