import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { KIND_ADVISORY_DECLINE } from './advisory';
import {
  KIND_OPENED,
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  STATUS_ACTIVE,
  STATUS_EXHAUSTED,
  STATUS_EXPIRED,
  STATUS_REVOKED,
} from './constants';
import type { MandateAccount } from './mandate';
import { VTEST_MINT } from './tokens';
import type { RingEntry } from './ring';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

const data = import('./widgetData');

const ADDRESS = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const OTHER = new PublicKey(Buffer.alloc(32, 8)).toBase58();
const AGENT = new PublicKey(Buffer.alloc(32, 4)).toBase58();
const NOW = new Date(2026, 8, 25, 8, 12, 0).getTime();
const NOW_SEC = BigInt(Math.floor(NOW / 1000));
const YESTERDAY = BigInt(Math.floor(new Date(2026, 8, 24, 18, 2, 0).getTime() / 1000));

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
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
    ...over,
  };
}

function row(over: Partial<RingEntry> = {}): RingEntry {
  return {
    ts: YESTERDAY,
    amount: 4n,
    counterparty: 'payee',
    nonce: 1n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    kindName: 'paid',
    reason: 0,
    reasonText: 'ok',
    ...over,
  };
}

test('the widget names the saved agent, then the rule purpose, then a short address', async () => {
  const { widgetAgentLabel, spendHeading } = await data;
  assert.equal(widgetAgentLabel('Research agent', 'research', AGENT), 'Research agent');
  assert.equal(spendHeading('Research agent'), 'Research agent can still spend');
  assert.equal(widgetAgentLabel('  ', 'research', AGENT), 'research');
  assert.equal(widgetAgentLabel(null, '   ', AGENT).startsWith('Agent '), true);
});

test('days left and the end date follow the rule clock', async () => {
  const { daysLeftLine, endsLine } = await data;
  assert.equal(daysLeftLine(NOW_SEC + 84n * 86_400n, NOW_SEC), '84 days left');
  assert.equal(daysLeftLine(NOW_SEC + 86_400n, NOW_SEC), '1 day left');
  assert.equal(daysLeftLine(NOW_SEC + 3n * 3600n, NOW_SEC), '3 hours left');
  assert.equal(daysLeftLine(NOW_SEC - 1n, NOW_SEC), 'Ended');
  assert.match(endsLine(NOW_SEC + 12n * 86_400n, NOW), /^ends \d+ \w+$/);
  const nextYear = BigInt(Math.floor(new Date(2027, 0, 2, 12, 0, 0).getTime() / 1000));
  assert.match(endsLine(nextYear, NOW), /^ends 2 Jan 2027$/);
});

test('a decision time is today, yesterday, a day count, or a date', async () => {
  const { decisionWhen, updatedLine } = await data;
  assert.equal(decisionWhen(YESTERDAY, NOW).phrase, 'yesterday 18:02');
  assert.equal(decisionWhen(YESTERDAY, NOW).day, 'yesterday');
  assert.match(decisionWhen(NOW_SEC, NOW).phrase, /^today 08:12$/);
  assert.equal(decisionWhen(NOW_SEC - 2n * 86_400n, NOW).day, '2 days ago');
  assert.match(decisionWhen(NOW_SEC - 8n * 86_400n, NOW).phrase, /\d+:\d+$/);
  assert.equal(updatedLine(NOW), 'Updated 25 Sep 08:12');
  assert.equal(updatedLine(0), 'Not updated yet');
});

test('the live line and the tally use the rule, not a sample', async () => {
  const { ruleLiveLine, tallyLine } = await data;
  assert.deepEqual(ruleLiveLine(mandate(), NOW_SEC), { live: true, line: 'Rule live' });
  assert.deepEqual(ruleLiveLine(mandate({ status: STATUS_REVOKED }), NOW_SEC), {
    live: false,
    line: 'Rule stopped',
  });
  assert.equal(ruleLiveLine(mandate({ status: STATUS_EXHAUSTED }), NOW_SEC).line, 'Nothing left to spend');
  assert.equal(
    ruleLiveLine(mandate({ status: STATUS_EXPIRED, expiresAt: NOW_SEC + 10n }), NOW_SEC).line,
    'Rule ended',
  );
  assert.equal(ruleLiveLine(mandate({ expiresAt: NOW_SEC - 5n }), NOW_SEC).line, 'Rule ended');
  assert.equal(tallyLine(2, 1), '2 paid, 1 refused');
});

test('the block bar ratio stays finite when the cap does not fit in a safe integer', async () => {
  const { barAmounts } = await data;
  assert.deepEqual(barAmounts(30n, 40n), { remaining: 30, cap: 40 });
  assert.deepEqual(barAmounts(0n, 0n), { remaining: 0, cap: 0 });
  const cap = BigInt(Number.MAX_SAFE_INTEGER) + 1_000_000n;
  const bar = barAmounts(cap / 2n, cap);
  assert.equal(Number.isFinite(bar.cap), true);
  assert.ok(bar.cap > 0);
  assert.ok(Math.abs(bar.remaining / bar.cap - 0.5) < 0.02);
});

test('the last decision is the newest payment, refusal, allowance, or decline', async () => {
  const { latestListedDecision, decisionCopy, WIDGET_NO_DECISION, WIDGET_DECISION_UNREAD } = await data;
  const paid = row();
  const older = row({ ts: YESTERDAY - 10n, kind: KIND_REFUSED, amount: 9n });
  const opened = row({ ts: YESTERDAY + 10n, kind: KIND_OPENED, amount: 1n });
  assert.equal(latestListedDecision([older, opened, paid])?.kind, KIND_PAID);
  assert.equal(latestListedDecision([opened]), null);
  assert.equal(decisionCopy(paid, 0, NOW, false).line, 'Last paid 4, yesterday 18:02');
  assert.equal(decisionCopy(paid, 0, NOW, false).short, 'Last: paid 4, yesterday');
  assert.equal(
    decisionCopy(row({ kind: KIND_REFUSED, amount: 6n }), 0, NOW, false).line,
    'Last refused 6, yesterday 18:02',
  );
  assert.equal(
    decisionCopy(row({ kind: KIND_OVERRIDE, amount: 7n }), 0, NOW, false).short,
    'Last: allowed 7, yesterday',
  );
  assert.match(
    decisionCopy(row({ kind: KIND_ADVISORY_DECLINE, amount: 3n }), 0, NOW, false).line,
    /^Last: the agent declined 3, yesterday 18:02$/,
  );
  assert.equal(decisionCopy(null, 0, NOW, false).line, WIDGET_NO_DECISION);
  assert.equal(decisionCopy(paid, 0, NOW, true).line, WIDGET_DECISION_UNREAD);
});

test('a rule face shows what that agent can still spend from the mandate', async () => {
  const { buildRuleFace, ruleWidgetUri } = await data;
  const face = buildRuleFace({
    mandate: mandate(),
    decimals: 0,
    savedName: 'Research agent',
    ledger: { entries: [row()] },
    nowMs: NOW,
    updatedLabel: 'Updated 25 Sep 08:12',
  });
  assert.equal(face.heading, 'Research agent can still spend');
  assert.equal(face.remainingText, '30 VTEST');
  assert.equal(face.capText, '40 VTEST');
  assert.equal(face.barRemaining, 30);
  assert.equal(face.barCap, 40);
  assert.equal(face.daysLeft, '12 days left');
  assert.equal(face.decisionLine, 'Last paid 4 VTEST, yesterday 18:02');
  assert.equal(face.tally, '2 paid, 1 refused');
  assert.equal(face.uri, ruleWidgetUri(ADDRESS));
  assert.equal(face.uri.startsWith('veto://rule/'), true);
});

test('the large widget follows the selected rule and a small widget follows its binding', async () => {
  const { assembleWidgetBoard, drawForSpend, drawForRule, WIDGET_EMPTY_COPY, WIDGET_PICK_COPY, WIDGET_RULE_GONE_COPY } =
    await data;
  const first = mandate();
  const second = mandate({
    address: OTHER,
    agent: new PublicKey(Buffer.alloc(32, 2)).toBase58(),
    purpose: 'charging',
    cap: 10n,
    spent: 1n,
    status: STATUS_ACTIVE,
  });
  const ledgers = new Map([
    [ADDRESS, { entries: [row()] }],
    [OTHER, { entries: [] as RingEntry[] }],
  ]);
  const board = assembleWidgetBoard({
    nowMs: NOW,
    mandates: [first, second],
    selectedAddress: OTHER,
    names: { [AGENT]: 'Research agent' },
    ledgers,
    decimalsFor: () => 0,
  });
  const large = drawForSpend(board);
  assert.equal(large.kind, 'rule');
  if (large.kind === 'rule') {
    assert.equal(large.face.address, OTHER);
    assert.equal(large.face.remainingText, '9 VTEST');
    assert.equal(large.size, 'large');
  }
  const small = drawForRule(board, { '7': ADDRESS }, 7);
  assert.equal(small.kind, 'rule');
  if (small.kind === 'rule') {
    assert.equal(small.face.heading, 'Research agent can still spend');
    assert.equal(small.size, 'small');
  }
  const unpicked = drawForRule(board, {}, 7);
  assert.deepEqual(unpicked, { kind: 'message', body: WIDGET_PICK_COPY });
  const gone = drawForRule(board, { '7': new PublicKey(Buffer.alloc(32, 1)).toBase58() }, 7);
  assert.deepEqual(gone, { kind: 'message', body: WIDGET_RULE_GONE_COPY });
  const empty = assembleWidgetBoard({
    nowMs: NOW,
    mandates: [],
    selectedAddress: null,
    names: {},
    ledgers: new Map(),
    decimalsFor: () => 0,
  });
  assert.equal(empty.status, 'empty');
  const drawn = drawForSpend(empty);
  assert.equal(drawn.kind, 'message');
  if (drawn.kind === 'message') {
    assert.equal(drawn.body, WIDGET_EMPTY_COPY);
  }
});

test('a missing ledger still shows the remaining cap and says the decision was not read', async () => {
  const { assembleWidgetBoard, WIDGET_DECISION_UNREAD } = await data;
  const board = assembleWidgetBoard({
    nowMs: NOW,
    mandates: [mandate()],
    selectedAddress: null,
    names: {},
    ledgers: new Map([[ADDRESS, { error: true }]]),
    decimalsFor: () => 0,
  });
  assert.equal(board.selected?.remainingText, '30 VTEST');
  assert.equal(board.selected?.decisionLine, WIDGET_DECISION_UNREAD);
});

test('widget bindings keep only a real rule address for a placed widget', async () => {
  const { parseWidgetBindings, withWidgetBinding, withoutWidgetBinding } = await data;
  assert.deepEqual(parseWidgetBindings(null), {});
  assert.deepEqual(parseWidgetBindings('not json'), {});
  assert.deepEqual(parseWidgetBindings('[]'), {});
  assert.deepEqual(parseWidgetBindings(JSON.stringify({ nope: ADDRESS, '3': 'not-an-address' })), {});
  const parsed = parseWidgetBindings(JSON.stringify({ '3': ADDRESS, '4': 'short' }));
  assert.deepEqual(parsed, { '3': ADDRESS });
  const bound = withWidgetBinding(parsed, 9, ADDRESS);
  assert.equal(bound['9'], ADDRESS);
  assert.equal(withWidgetBinding(bound, -1, ADDRESS), bound);
  assert.equal(withWidgetBinding(bound, 9, 'not-an-address'), bound);
  assert.deepEqual(withoutWidgetBinding(bound, 3), { '9': ADDRESS });
});

test('the catch mark, the selected-rule key, and the widget config match the app', async () => {
  const { CATCH_MARK_PATH, SELECTED_RULE_KEY, SPEND_WIDGET_NAME, RULE_WIDGET_NAME } = await data;
  const mark = readFileSync(new URL('../components/backglass/CatchMark.tsx', import.meta.url), 'utf8');
  const chain = readFileSync(new URL('./useChain.ts', import.meta.url), 'utf8');
  const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
    expo: { plugins: unknown[] };
  };
  assert.equal(mark.includes(CATCH_MARK_PATH), true);
  assert.match(chain, new RegExp(`SELECTED_MANDATE_KEY = '${SELECTED_RULE_KEY}'`));
  const entry = config.expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'react-native-android-widget',
  ) as [string, { fonts: string[]; widgets: { name: string }[] }] | undefined;
  assert.ok(entry);
  assert.deepEqual(
    entry[1].widgets.map((widget) => widget.name),
    [SPEND_WIDGET_NAME, RULE_WIDGET_NAME],
  );
  for (const font of entry[1].fonts) {
    assert.equal(existsSync(new URL(`../${font.slice(2)}`, import.meta.url)), true);
  }
  const face = readFileSync(new URL('../widgets/HomeWidgetFace.tsx', import.meta.url), 'utf8');
  const drawing = readFileSync(new URL('../widgets/androidWidget.tsx', import.meta.url), 'utf8');
  assert.equal(face.includes('258'), false);
  assert.equal(face.includes('Charging'), false);
  assert.equal(drawing.includes('258'), false);
  assert.equal(drawing.includes('Charging'), false);
});
