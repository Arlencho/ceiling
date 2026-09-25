import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Keypair } from '@solana/web3.js';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';
import { defaultQuietSettings, quietNoteCopy, type QuietSettings } from './quietNote';
import { buildRenewalView, type RenewalView } from './renewal';
import { VTEST_MINT } from './tokens';

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
    Animated: {
      Value: AnimatedValue,
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing: () => animation,
      sequence: () => animation,
      loop: () => animation,
      delay: () => animation,
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (fn: (value: number) => number) => fn,
      in: (fn: (value: number) => number) => fn,
      inOut: (fn: (value: number) => number) => fn,
      bezier: () => (value: number) => value,
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

mock.module('react-native-svg', {
  namedExports: {
    Circle: Host('Circle'),
    Path: Host('Path'),
    Svg: Host('Svg'),
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

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

function press(root: ReactTestRenderer, label: string) {
  const found = root.root
    .findAll((node) => (node.type as unknown) === 'Pressable')
    .find((node) => String(node.props.accessibilityLabel ?? '') === label || String(node.props.accessibilityLabel ?? '').startsWith(label));
  assert.ok(found, label);
  return found;
}

const DAY = 86400n;
const EXPIRES = 1_800_000_000n;
const NOW = EXPIRES - 7n * DAY;
const MERCHANT = Keypair.generate().publicKey.toBase58();
const AGENT = Keypair.generate().publicKey.toBase58();

function rule(): MandateAccount {
  return {
    address: 'rule-ending',
    owner: 'owner',
    agent: AGENT,
    mint: VTEST_MINT,
    source: 'source',
    merchant: MERCHANT,
    mandateId: 1n,
    cap: 80n,
    spent: 17n,
    perTxMax: 6n,
    expiresAt: EXPIRES,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 2n,
    purpose: 'depot top ups',
    status: STATUS_ACTIVE,
    spendCount: 4,
    refusalCount: 2,
    bump: 1,
  };
}

function view(): RenewalView {
  const built = buildRenewalView({
    mandate: rule(),
    rows: [
      { ts: EXPIRES - 90n * DAY, kind: KIND_OPENED, amount: 80n },
      { ts: EXPIRES - 30n * DAY, kind: KIND_PAID, amount: 6n },
      { ts: EXPIRES - 12n * DAY, kind: KIND_REFUSED, amount: 19n },
      { ts: EXPIRES - 11n * DAY, kind: KIND_OVERRIDE, amount: 19n },
    ],
    decimals: 0,
    nowSec: NOW,
    agentName: 'Depot agent',
    ledgerTotal: 4,
  });
  assert.ok(built);
  return built;
}

const quietNow = new Date(2026, 5, 15, 20, 52, 0, 0);

function noteSettings(partial: Partial<QuietSettings> = {}): QuietSettings {
  return { ...defaultQuietSettings(), ...partial };
}

function noteCopy() {
  return quietNoteCopy({
    name: 'Depot agent',
    cap: 9n,
    spent: 5n,
    expiresAt: BigInt(Math.floor(quietNow.getTime() / 1000) + 40 * 86400),
    decimals: 0,
    mint: VTEST_MINT,
    rows: [{ ts: BigInt(Math.floor(quietNow.getTime() / 1000)), kind: KIND_REFUSED, amount: 3n }],
    ledgerTotal: 1,
    now: quietNow,
  });
}

test('the renewal screen reads loading, an absent rule, a failed read, and the chain record', async () => {
  const { RenewalScreen } = await import('../components/renewal/RenewalScreen');
  const base = {
    decimals: 0,
    nowSec: NOW,
    cluster: 'Test tokens',
    letEndNote: null,
    onClose: () => undefined,
    onSetup: () => undefined,
    onLetEnd: () => undefined,
  };
  let root = await mount(createElement(RenewalScreen, { ...base, status: 'loading', message: null, view: null }));
  assert.match(textOf(root), /Reading this rule from the blockchain/);
  await act(async () => root.unmount());

  root = await mount(
    createElement(RenewalScreen, {
      ...base,
      status: 'empty',
      message: 'This rule is not on chain for this owner.',
      view: null,
    }),
  );
  assert.match(textOf(root), /not on chain for this owner/);
  await act(async () => root.unmount());

  root = await mount(
    createElement(RenewalScreen, {
      ...base,
      status: 'error',
      message: 'The decision record could not be read.',
      view: null,
    }),
  );
  assert.match(textOf(root), /could not be read/);
  await act(async () => root.unmount());

  const model = view();
  const setups: unknown[] = [];
  let endings = 0;
  root = await mount(
    createElement(RenewalScreen, {
      ...base,
      status: 'ready',
      message: null,
      view: model,
      onSetup: (draft) => {
        setups.push(draft);
      },
      onLetEnd: () => {
        endings += 1;
      },
    }),
  );
  const shown = textOf(root);
  assert.match(shown, /Your rule ends in 7 days/);
  assert.match(shown, /Depot agent/);
  assert.match(shown, /19 VTEST, refused/);
  assert.match(shown, /6 VTEST, the limit/);
  assert.match(shown, /1 time/);
  assert.match(shown, /63 VTEST was never needed/);
  assert.match(shown, /90 days, to /);
  assert.match(shown, /Let this one end/);
  assert.match(shown, /Nothing else happens/);
  assert.match(shown, /The next rule starts only after you sign it on this phone/);
  assert.doesNotMatch(shown, /Hold to approve/);
  assert.doesNotMatch(shown, /258 of 300|261|57 paid/);
  await act(async () => {
    press(root, 'Let this one end').props.onPress();
  });
  assert.equal(endings, 1);
  assert.equal(setups.length, 0);
  await act(async () => root.unmount());
});

test('changing the next rule is visible, and an empty length does not open the signing flow', async () => {
  const { RenewalScreen } = await import('../components/renewal/RenewalScreen');
  const setups: { expiryDays: string; perTxMax: string }[] = [];
  const root = await mount(
    createElement(RenewalScreen, {
      status: 'ready',
      message: null,
      view: view(),
      decimals: 0,
      nowSec: NOW,
      cluster: 'Test tokens',
      letEndNote: null,
      onClose: () => undefined,
      onLetEnd: () => undefined,
      onSetup: (draft) => {
        setups.push({ expiryDays: draft.expiryDays, perTxMax: draft.perTxMax });
      },
    }),
  );
  await act(async () => {
    press(root, 'Change Most per payment').props.onPress();
  });
  const field = root.root
    .findAll((node) => (node.type as unknown) === 'TextInput')
    .find((node) => node.props.accessibilityLabel === 'Most per payment');
  assert.ok(field);
  await act(async () => {
    field.props.onChangeText('12');
  });
  assert.match(textOf(root), /You changed the next rule/);
  await act(async () => {
    press(root, 'Set up the next rule').props.onPress();
  });
  assert.equal(setups.length, 1);
  assert.equal(setups[0]?.perTxMax, '12');

  await act(async () => {
    press(root, 'Change Runs for').props.onPress();
  });
  const days = root.root
    .findAll((node) => (node.type as unknown) === 'TextInput')
    .find((node) => node.props.accessibilityLabel === 'Runs for');
  assert.ok(days);
  await act(async () => {
    days.props.onChangeText('');
  });
  await act(async () => {
    press(root, 'Set up the next rule').props.onPress();
  });
  assert.match(textOf(root), /Enter how many days the next rule runs/);
  assert.equal(setups.length, 1);
  await act(async () => root.unmount());
});

test('letting the rule end shows that nothing was signed', async () => {
  const { RenewalScreen } = await import('../components/renewal/RenewalScreen');
  const root = await mount(
    createElement(RenewalScreen, {
      status: 'ready',
      message: null,
      view: view(),
      decimals: 0,
      nowSec: NOW,
      cluster: 'Test tokens',
      letEndNote: 'Nothing was signed. This choice costs nothing.',
      onClose: () => undefined,
      onSetup: () => undefined,
      onLetEnd: () => undefined,
    }),
  );
  assert.match(textOf(root), /Nothing was signed/);
  assert.match(textOf(root), /costs nothing/);
  await act(async () => root.unmount());
});

test('the home banner appears only inside the seven days and opens the renewal screen', async () => {
  const { RenewalBanner, HomeStay } = await import('../components/renewal/RenewalBanner');
  const live = rule();
  let opened = 0;
  let root = await mount(
    createElement(RenewalBanner, {
      mandate: live,
      decimals: 0,
      nowSec: NOW,
      onOpen: () => {
        opened += 1;
      },
    }),
  );
  assert.match(textOf(root), /Your rule ends in 7 days/);
  assert.match(textOf(root), /63 VTEST left/);
  await act(async () => {
    press(root, 'Your rule ends in 7 days').props.onPress();
  });
  assert.equal(opened, 1);
  await act(async () => root.unmount());

  root = await mount(
    createElement(RenewalBanner, {
      mandate: live,
      decimals: 0,
      nowSec: EXPIRES - 8n * DAY,
      onOpen: () => undefined,
    }),
  );
  assert.equal(textOf(root), '');
  await act(async () => root.unmount());

  let quiet = 0;
  root = await mount(
    createElement(HomeStay, {
      mandate: live,
      decimals: 0,
      nowSec: EXPIRES - 8n * DAY,
      onRenew: () => undefined,
      onQuietNote: () => {
        quiet += 1;
      },
    }),
  );
  assert.match(textOf(root), /A quiet note each day/);
  assert.match(textOf(root), /never more than one/);
  assert.doesNotMatch(textOf(root), /Rule ending soon/);
  await act(async () => {
    press(root, 'A quiet note each day').props.onPress();
  });
  assert.equal(quiet, 1);
  await act(async () => root.unmount());
});

test('the quiet note screen reads loading, no rule, a failed read, and today', async () => {
  const { QuietNoteScreen } = await import('../components/renewal/QuietNoteScreen');
  const base = {
    settings: noteSettings(),
    copy: null,
    cluster: 'Test tokens',
    notice: null,
    onBack: () => undefined,
    onSave: () => undefined,
  };
  let root = await mount(createElement(QuietNoteScreen, { ...base, status: 'loading', message: null, settings: null }));
  assert.match(textOf(root), /Reading decisions from today/);
  assert.match(textOf(root), /every 15 minutes/);
  assert.match(textOf(root), /Battery saving can delay a check/);
  await act(async () => root.unmount());

  root = await mount(createElement(QuietNoteScreen, { ...base, status: 'empty', message: null }));
  assert.match(textOf(root), /no live rule/);
  assert.match(textOf(root), /stays off/);
  await act(async () => root.unmount());

  root = await mount(
    createElement(QuietNoteScreen, {
      ...base,
      status: 'error',
      message: "Today's decisions could not be read.",
    }),
  );
  assert.match(textOf(root), /could not be read/);
  await act(async () => root.unmount());

  const copy = noteCopy();
  const saved: QuietSettings[] = [];
  root = await mount(
    createElement(QuietNoteScreen, {
      status: 'ready',
      message: null,
      settings: noteSettings(),
      copy,
      cluster: 'Test tokens',
      notice: null,
      onBack: () => undefined,
      onSave: (next) => {
        saved.push(next);
      },
    }),
  );
  const shown = textOf(root);
  assert.match(shown, /Hear that all is well, once a day/);
  assert.match(shown, /Every evening/);
  assert.match(shown, /Only on days something moved/);
  assert.match(shown, /Never/);
  assert.match(shown, /21:00/);
  assert.match(shown, /Turn on the quiet note/);
  assert.match(shown, /Depot agent asked once outside the rule and was refused/);
  assert.match(shown, /4 VTEST of 9 VTEST left/);
  assert.match(shown, /Last check 20:52/);
  assert.doesNotMatch(shown, /The quiet note is on/);
  assert.doesNotMatch(shown, /258 of 300/);
  assert.doesNotMatch(shown, /Charging agent/);
  await act(async () => {
    press(root, 'Change the time').props.onPress();
  });
  await act(async () => {
    press(root, 'Later hour').props.onPress();
  });
  assert.match(textOf(root), /22:00/);
  await act(async () => {
    press(root, 'Only on days something moved').props.onPress();
  });
  const selected = press(root, 'Only on days something moved');
  assert.equal(selected.props.accessibilityState.selected, true);
  await act(async () => {
    press(root, 'Turn on the quiet note').props.onPress();
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.enabled, true);
  assert.equal(saved[0]?.send, 'moved');
  assert.equal(saved[0]?.hour, 22);
  await act(async () => {
    press(root, 'Never').props.onPress();
  });
  await act(async () => {
    press(root, 'Keep the quiet note off').props.onPress();
  });
  assert.equal(saved[1]?.send, 'never');
  assert.equal(saved[1]?.enabled, false);
  await act(async () => root.unmount());
});

test('a quiet note that is already on says so, and Not now leaves without saving', async () => {
  const { QuietNoteScreen } = await import('../components/renewal/QuietNoteScreen');
  let backs = 0;
  const saved: QuietSettings[] = [];
  const root = await mount(
    createElement(QuietNoteScreen, {
      status: 'ready',
      message: null,
      settings: noteSettings({ enabled: true, send: 'every-evening' }),
      copy: noteCopy(),
      cluster: 'Test tokens',
      notice: null,
      onBack: () => {
        backs += 1;
      },
      onSave: (next) => {
        saved.push(next);
      },
    }),
  );
  assert.match(textOf(root), /The quiet note is on/);
  assert.match(textOf(root), /Save the quiet note/);
  await act(async () => {
    press(root, 'Not now').props.onPress();
  });
  assert.equal(backs, 1);
  assert.equal(saved.length, 0);
  await act(async () => root.unmount());
});
