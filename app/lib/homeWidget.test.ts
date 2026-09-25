import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { PublicKey } from '@solana/web3.js';

import { KIND_PAID, STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';
import { VTEST_MINT } from './tokens';
import type { RingEntry } from './ring';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

const motion = { reduced: true };

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

class AnimatedValue {
  _value: number;
  constructor(value: number) {
    this._value = value;
  }
  setValue(value: number) {
    this._value = value;
  }
  interpolate(config: unknown) {
    return { __animated: 'interpolate', config, value: this };
  }
}

function timing(value: { setValue: (next: number) => void }, config: { toValue: number }) {
  return {
    start() {
      value.setValue(config.toValue);
    },
    stop() {
      return undefined;
    },
  };
}

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(motion.reduced),
      addEventListener: () => ({ remove() {} }),
    },
    Animated: {
      Value: AnimatedValue,
      View: Host('Animated.View'),
      timing,
      sequence: (anims: { start: () => void; stop: () => void }[]) => ({
        start() {
          anims[0]?.start();
        },
        stop() {
          anims.forEach((anim) => anim.stop());
        },
      }),
    },
    Easing: {
      bezier: () => (amount: number) => amount,
    },
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
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
    Defs: Host('Defs'),
    LinearGradient: Host('LinearGradient'),
    Stop: Host('Stop'),
  },
});

const ADDRESS = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const AGENT = new PublicKey(Buffer.alloc(32, 4)).toBase58();
const NOW = new Date(2026, 8, 25, 8, 12, 0).getTime();
const NOW_SEC = BigInt(Math.floor(NOW / 1000));

function mandate(): MandateAccount {
  return {
    address: ADDRESS,
    owner: new PublicKey(Buffer.alloc(32, 3)).toBase58(),
    agent: AGENT,
    mint: VTEST_MINT,
    source: new PublicKey(Buffer.alloc(32, 6)).toBase58(),
    merchant: new PublicKey(Buffer.alloc(32, 7)).toBase58(),
    mandateId: 1n,
    cap: 40n,
    spent: 10n,
    perTxMax: 8n,
    expiresAt: NOW_SEC + 12n * 86_400n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 1n,
    purpose: 'research',
    status: STATUS_ACTIVE,
    spendCount: 2,
    refusalCount: 1,
    bump: 1,
  };
}

function paid(): RingEntry {
  return {
    ts: BigInt(Math.floor(new Date(2026, 8, 24, 18, 2, 0).getTime() / 1000)),
    amount: 4n,
    counterparty: 'payee',
    nonce: 1n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    kindName: 'paid',
    reason: 0,
    reasonText: 'ok',
  };
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((item) => flatStyle(item)));
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

function visibleText(root: ReactTestRenderer): string {
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
  for (const node of root.root.findAll((candidate) => (candidate.type as unknown) === 'Text')) {
    walk(node.props.children);
  }
  return bits.join('\n');
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  assert.ok(root);
  return root;
}

async function readyFace() {
  const { buildRuleFace } = await import('./widgetData');
  return buildRuleFace({
    mandate: mandate(),
    decimals: 0,
    savedName: 'Research agent',
    ledger: { entries: [paid()] },
    nowMs: NOW,
    updatedLabel: 'Updated 25 Sep 08:12',
  });
}

test('the loading widget says it is reading and does not invent a balance', async () => {
  motion.reduced = true;
  const { HomeWidgetFace } = await import('../widgets/HomeWidgetFace');
  const root = await mount(createElement(HomeWidgetFace, { status: 'loading', size: 'large' }));
  const text = visibleText(root);
  assert.match(text, /Reading what this agent can still spend/);
  assert.equal(text.includes('258'), false);
  assert.equal(root.root.findAll((node) => node.props.accessibilityRole === 'progressbar').length, 0);
  assert.ok(root.root.findByProps({ accessibilityLabel: 'Veto Catch mark' }));
  assert.ok(
    root.root.findByProps({
      accessibilityLabel: 'Veto widget. Reading what this agent can still spend',
    }),
  );
});

test('the empty widget tells the owner to approve a rule', async () => {
  motion.reduced = true;
  const { HomeWidgetFace } = await import('../widgets/HomeWidgetFace');
  const root = await mount(
    createElement(HomeWidgetFace, {
      status: 'empty',
      size: 'large',
      message: 'No rule yet. Approve a rule in Veto and this widget will show what that agent can still spend.',
    }),
  );
  const text = visibleText(root);
  assert.match(text, /No rule yet/);
  assert.match(text, /what that agent can still spend/);
  assert.equal(text.includes('30'), false);
  assert.equal(root.root.findAll((node) => node.props.accessibilityRole === 'progressbar').length, 0);
});

test('the error widget says the read failed and keeps the sample numbers off the card', async () => {
  motion.reduced = true;
  const { HomeWidgetFace } = await import('../widgets/HomeWidgetFace');
  const root = await mount(
    createElement(HomeWidgetFace, {
      status: 'error',
      size: 'large',
      message: 'Could not read what this agent can still spend.',
    }),
  );
  const text = visibleText(root);
  assert.equal(text.includes('Could not read what this agent can still spend.'), true);
  assert.equal(text.includes('258'), false);
  assert.equal(text.includes('of 300'), false);
  assert.equal(root.root.findAll((node) => node.props.accessibilityRole === 'progressbar').length, 0);
});

test('the large widget shows what the agent can still spend, the last decision, and the days left', async () => {
  motion.reduced = true;
  const { HomeWidgetFace } = await import('../widgets/HomeWidgetFace');
  const face = await readyFace();
  const root = await mount(createElement(HomeWidgetFace, { status: 'ready', size: 'large', face }));
  const text = visibleText(root);
  assert.match(text, /Research agent can still spend/);
  assert.match(text, /^30 VTEST$/m);
  assert.match(text, /of \n40 VTEST/);
  assert.match(text, /12 days left/);
  assert.match(text, /Last paid 4 VTEST, yesterday 18:02/);
  assert.match(text, /2 paid, 1 refused/);
  assert.match(text, /Rule live/);
  assert.match(text, /Updated 25 Sep 08:12/);
  assert.equal(text.includes('258'), false);
  const bar = root.root.findByProps({ accessibilityRole: 'progressbar' });
  assert.equal(bar.props.accessibilityLabel, '30 VTEST remaining of 40 VTEST');
  assert.equal(flatStyle(root.root.findByProps({ testID: 'block-fill-21' }).props.style).width, '100%');
  assert.equal(flatStyle(root.root.findByProps({ testID: 'block-fill-22' }).props.style).width, '50%');
  assert.ok(root.root.findByProps({ accessibilityLabel: 'Veto Catch mark' }));
});

test('a small widget shows that rule and its last decision', async () => {
  motion.reduced = true;
  const { HomeWidgetFace } = await import('../widgets/HomeWidgetFace');
  const face = await readyFace();
  const root = await mount(createElement(HomeWidgetFace, { status: 'ready', size: 'small', face }));
  const text = visibleText(root);
  assert.match(text, /Research agent can still spend/);
  assert.match(text, /of \n40 VTEST/);
  assert.match(text, /Last: paid 4 VTEST, yesterday/);
  assert.equal(text.includes('days left'), false);
  assert.equal(text.includes('2 paid'), false);
  assert.equal(root.root.findAll((node) => node.props.accessibilityRole === 'progressbar').length, 0);
  assert.ok(root.root.findByProps({ accessibilityLabel: 'Veto Catch mark' }));
});

test('reduced motion shows the block bar already revealed, and motion covers it until the reveal runs', async () => {
  const { HomeWidgetFace } = await import('../widgets/HomeWidgetFace');
  const face = await readyFace();
  motion.reduced = true;
  const still = await mount(createElement(HomeWidgetFace, { status: 'ready', size: 'large', face }));
  assert.equal(
    still.root.findAll((node) => String(node.props.testID ?? '').startsWith('block-cover')).length,
    0,
  );
  motion.reduced = false;
  const moving = await mount(createElement(HomeWidgetFace, { status: 'ready', size: 'large', face }));
  const covers = moving.root.findAll(
    (node) =>
      String(node.type) === 'Animated.View' && String(node.props.testID ?? '').startsWith('block-cover'),
  );
  assert.equal(covers.length, 1);
});
