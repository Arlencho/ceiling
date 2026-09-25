import { PublicKey } from '@solana/web3.js';

import { KIND_ADVISORY_DECLINE } from './advisory';
import { loadAddressBook } from './addressBook';
import {
  createClient,
  fetchLedger,
  fetchLedgerRows,
  fetchMintDecimals,
  fetchOwnerMandates,
  pickMandate,
} from './chain';
import { fetchOwnerTradeRules, fetchTradeLedgerRows } from './tradeChain';
import { tradeRuleAsMandate } from './tradeRule';
import {
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  STATUS_EXHAUSTED,
  STATUS_EXPIRED,
  STATUS_REVOKED,
} from './constants';
import {
  formatClock,
  isListedDecision,
  remainingCap,
  timeLeftParts,
} from './format';
import { formatTokenAmount } from './tokens';
import { isActive, type MandateAccount } from './mandate';
import { isRateLimitError } from './rpcError';
import type { RingEntry } from './ring';
import { canonicalAddress } from './ruleRequest';
import { displayPurpose } from './ruleView';
import { loadSession, truncateAddress } from './wallet';

export const SPEND_WIDGET_NAME = 'Spend';
export const RULE_WIDGET_NAME = 'Rule';

// The same key useChain writes when the owner switches rules.
export const SELECTED_RULE_KEY = 'veto.mandate.selected';
export const WIDGET_BINDINGS_KEY = 'veto.widget.bindings';

// Same path the cabinet mark draws. CatchMark owns the painted copy.
export const CATCH_MARK_PATH = 'M16 14L50 80L84 14';

export const WIDGET_LOADING_COPY = 'Reading what this agent can still spend';
export const WIDGET_SIGNED_OUT_COPY = 'Sign in to Veto to see what your agent can still spend.';
export const WIDGET_EMPTY_COPY =
  'No rule yet. Approve a rule in Veto and this widget will show what that agent can still spend.';
export const WIDGET_ERROR_COPY = 'Could not read what this agent can still spend.';
export const WIDGET_RATE_LIMIT_COPY = 'Too many reads at once. This widget will try again on the next update.';
export const WIDGET_RULE_GONE_COPY = 'This rule is no longer on the chain.';
export const WIDGET_PICK_COPY = 'Pick a rule for this widget.';
export const WIDGET_DECISION_UNREAD = 'Could not read the last decision';
export const WIDGET_NO_DECISION = 'No payment or refusal yet';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type WidgetLedger = { entries: readonly RingEntry[] } | { error: true };

export type WidgetRuleFace = {
  address: string;
  label: string;
  heading: string;
  remainingText: string;
  capText: string;
  barRemaining: number;
  barCap: number;
  daysLeft: string;
  ends: string;
  live: boolean;
  statusLine: string;
  tally: string;
  decisionLine: string;
  decisionShort: string;
  updatedLabel: string;
  uri: string;
};

export type WidgetBoard = {
  status: 'empty' | 'error' | 'ready';
  message: string;
  updatedAtMs: number;
  updatedLabel: string;
  selected: WidgetRuleFace | null;
  rules: WidgetRuleFace[];
};

export type WidgetDraw =
  | { kind: 'message'; body: string }
  | { kind: 'rule'; face: WidgetRuleFace; size: 'large' | 'small' };

export function widgetAgentLabel(
  savedName: string | null | undefined,
  purpose: string,
  agent: string,
): string {
  const saved = savedName?.trim() ?? '';
  if (saved.length > 0) {
    return saved;
  }
  const purposeText = displayPurpose(purpose).trim();
  if (purposeText.length > 0) {
    return purposeText;
  }
  const short = truncateAddress(agent);
  return short.length > 0 ? `Agent ${short}` : 'This agent';
}

export function spendHeading(label: string): string {
  return `${label} can still spend`;
}

export function daysLeftLine(expiresAt: bigint, nowSec: bigint): string {
  const parts = timeLeftParts(expiresAt, nowSec);
  if (parts.label === 'expired') {
    return 'Ended';
  }
  return `${parts.value} ${parts.label}`;
}

export function endsLine(expiresAt: bigint, nowMs: number): string {
  const date = new Date(Number(expiresAt) * 1000);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const day = `${date.getDate()} ${SHORT_MONTHS[date.getMonth()] ?? ''}`.trim();
  const now = new Date(nowMs);
  if (date.getFullYear() === now.getFullYear()) {
    return `ends ${day}`;
  }
  return `ends ${day} ${date.getFullYear()}`;
}

export function decisionWhen(unixSeconds: bigint, nowMs: number): { phrase: string; day: string } {
  const then = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(then.getTime())) {
    return { phrase: '', day: '' };
  }
  const clock = formatClock(unixSeconds);
  const startThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const now = new Date(nowMs);
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayDiff = Math.round((startNow - startThen) / 86_400_000);
  if (dayDiff <= 0) {
    return { phrase: `today ${clock}`, day: 'today' };
  }
  if (dayDiff === 1) {
    return { phrase: `yesterday ${clock}`, day: 'yesterday' };
  }
  if (dayDiff < 7) {
    return { phrase: `${dayDiff} days ago`, day: `${dayDiff} days ago` };
  }
  const date = `${then.getDate()} ${SHORT_MONTHS[then.getMonth()] ?? ''}`.trim();
  return { phrase: `${date} ${clock}`, day: date };
}

export function updatedLine(updatedAtMs: number): string {
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return 'Not updated yet';
  }
  const date = new Date(updatedAtMs);
  if (Number.isNaN(date.getTime())) {
    return 'Not updated yet';
  }
  const day = `${date.getDate()} ${SHORT_MONTHS[date.getMonth()] ?? ''}`.trim();
  return `Updated ${day} ${formatClock(BigInt(Math.floor(updatedAtMs / 1000)))}`;
}

export function tallyLine(paid: number, refused: number): string {
  return `${paid} paid, ${refused} refused`;
}

export function ruleLiveLine(mandate: MandateAccount, nowSec: bigint): { live: boolean; line: string } {
  if (isActive(mandate, nowSec)) {
    return { live: true, line: 'Rule live' };
  }
  if (mandate.status === STATUS_REVOKED) {
    return { live: false, line: 'Rule stopped' };
  }
  if (mandate.status === STATUS_EXHAUSTED) {
    return { live: false, line: 'Nothing left to spend' };
  }
  if (mandate.status === STATUS_EXPIRED || nowSec >= mandate.expiresAt) {
    return { live: false, line: 'Rule ended' };
  }
  return { live: false, line: 'Rule not live' };
}

export function barAmounts(remaining: bigint, cap: bigint): { remaining: number; cap: number } {
  if (cap <= 0n) {
    return { remaining: 0, cap: 0 };
  }
  const left = remaining > cap ? cap : remaining > 0n ? remaining : 0n;
  if (cap <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return { remaining: Number(left), cap: Number(cap) };
  }
  const scale = cap / 1_000_000n;
  const divisor = scale > 0n ? scale : 1n;
  return { remaining: Number(left / divisor), cap: Number(cap / divisor) };
}

export function latestListedDecision<T extends { ts: bigint; kind: number }>(
  entries: readonly T[],
): T | null {
  let best: T | null = null;
  for (const row of entries) {
    if (!isListedDecision(row.kind)) {
      continue;
    }
    if (!best || row.ts >= best.ts) {
      best = row;
    }
  }
  return best;
}

export function decisionCopy(
  row: RingEntry | null,
  decimals: number,
  nowMs: number,
  ledgerError: boolean,
  mint?: string | null,
): { line: string; short: string } {
  if (ledgerError) {
    return { line: WIDGET_DECISION_UNREAD, short: WIDGET_DECISION_UNREAD };
  }
  if (!row) {
    return { line: WIDGET_NO_DECISION, short: WIDGET_NO_DECISION };
  }
  const amount = formatTokenAmount(row.amount, decimals, mint);
  const when = decisionWhen(row.ts, nowMs);
  if (row.kind === KIND_PAID && row.family === 'trade') {
    const bought =
      row.amountOut != null
        ? formatTokenAmount(row.amountOut, row.outDecimals ?? decimals, row.outMint)
        : null;
    const line = bought
      ? `Last traded ${amount} for ${bought}, ${when.phrase}`
      : `Last traded ${amount}, ${when.phrase}`;
    const short = bought
      ? `Last: traded ${amount} for ${bought}, ${when.day}`
      : `Last: traded ${amount}, ${when.day}`;
    return { line, short };
  }
  if (row.kind === KIND_PAID) {
    return {
      line: `Last paid ${amount}, ${when.phrase}`,
      short: `Last: paid ${amount}, ${when.day}`,
    };
  }
  if (row.kind === KIND_REFUSED) {
    return {
      line: `Last refused ${amount}, ${when.phrase}`,
      short: `Last: refused ${amount}, ${when.day}`,
    };
  }
  if (row.kind === KIND_OVERRIDE) {
    return {
      line: `Last allowed ${amount}, ${when.phrase}`,
      short: `Last: allowed ${amount}, ${when.day}`,
    };
  }
  if (row.kind === KIND_ADVISORY_DECLINE) {
    return {
      line: `Last: the agent declined ${amount}, ${when.phrase}`,
      short: `Last: declined ${amount}, ${when.day}`,
    };
  }
  return { line: WIDGET_NO_DECISION, short: WIDGET_NO_DECISION };
}

export function ruleWidgetUri(address: string): string {
  return `veto://rule/${encodeURIComponent(address)}`;
}

export function describeWidget(face: WidgetRuleFace, size: 'large' | 'small'): string {
  if (size === 'small') {
    return `Veto widget. ${face.heading} ${face.remainingText} of ${face.capText}. ${face.decisionShort}. ${face.updatedLabel}.`;
  }
  return `Veto widget. ${face.heading} ${face.remainingText} of ${face.capText}. ${face.statusLine}. ${face.decisionLine}. ${face.daysLeft}. ${face.tally}. ${face.updatedLabel}.`;
}

export function buildRuleFace(args: {
  mandate: MandateAccount;
  decimals: number;
  savedName: string | null;
  ledger: WidgetLedger;
  nowMs: number;
  updatedLabel: string;
}): WidgetRuleFace {
  const nowSec = BigInt(Math.floor(args.nowMs / 1000));
  const remaining = remainingCap(args.mandate.cap, args.mandate.spent);
  const bar = barAmounts(remaining, args.mandate.cap);
  const label = widgetAgentLabel(args.savedName, args.mandate.purpose, args.mandate.agent);
  const live = ruleLiveLine(args.mandate, nowSec);
  const entries = 'entries' in args.ledger ? args.ledger.entries : null;
  const decision = decisionCopy(
    entries ? latestListedDecision(entries) : null,
    args.decimals,
    args.nowMs,
    entries == null,
    args.mandate.mint,
  );
  return {
    address: args.mandate.address,
    label,
    heading: spendHeading(label),
    remainingText: formatTokenAmount(remaining, args.decimals, args.mandate.mint),
    capText: formatTokenAmount(args.mandate.cap, args.decimals, args.mandate.mint),
    barRemaining: bar.remaining,
    barCap: bar.cap,
    daysLeft: daysLeftLine(args.mandate.expiresAt, nowSec),
    ends: endsLine(args.mandate.expiresAt, args.nowMs),
    live: live.live,
    statusLine: live.line,
    tally: tallyLine(args.mandate.spendCount, args.mandate.refusalCount),
    decisionLine: decision.line,
    decisionShort: decision.short,
    updatedLabel: args.updatedLabel,
    uri: ruleWidgetUri(args.mandate.address),
  };
}

export function boardWithMessage(nowMs: number, status: 'empty' | 'error', message: string): WidgetBoard {
  return {
    status,
    message,
    updatedAtMs: nowMs,
    updatedLabel: updatedLine(nowMs),
    selected: null,
    rules: [],
  };
}

export function assembleWidgetBoard(args: {
  nowMs: number;
  mandates: MandateAccount[];
  selectedAddress: string | null;
  names: Record<string, string>;
  ledgers: ReadonlyMap<string, WidgetLedger>;
  decimalsFor: (mandate: MandateAccount) => number;
}): WidgetBoard {
  const updatedLabel = updatedLine(args.nowMs);
  const rules = args.mandates.map((mandate) =>
    buildRuleFace({
      mandate,
      decimals: args.decimalsFor(mandate),
      savedName: args.names[mandate.agent] ?? null,
      ledger: args.ledgers.get(mandate.address) ?? { error: true },
      nowMs: args.nowMs,
      updatedLabel,
    }),
  );
  const selectedMandate = pickMandate(args.mandates, args.selectedAddress);
  const selected = selectedMandate
    ? (rules.find((rule) => rule.address === selectedMandate.address) ?? null)
    : null;
  if (!selected) {
    return boardWithMessage(args.nowMs, 'empty', WIDGET_EMPTY_COPY);
  }
  return {
    status: 'ready',
    message: '',
    updatedAtMs: args.nowMs,
    updatedLabel,
    selected,
    rules,
  };
}

export function drawForSpend(board: WidgetBoard): WidgetDraw {
  if (board.status !== 'ready' || !board.selected) {
    return { kind: 'message', body: board.message };
  }
  return { kind: 'rule', face: board.selected, size: 'large' };
}

export function drawForRule(
  board: WidgetBoard,
  bindings: Record<string, string>,
  widgetId: number,
): WidgetDraw {
  if (board.status !== 'ready') {
    return { kind: 'message', body: board.message };
  }
  const address = bindings[String(widgetId)];
  if (!address) {
    return { kind: 'message', body: WIDGET_PICK_COPY };
  }
  const face = board.rules.find((rule) => rule.address === address);
  if (!face) {
    return { kind: 'message', body: WIDGET_RULE_GONE_COPY };
  }
  return { kind: 'rule', face, size: 'small' };
}

export function parseWidgetBindings(raw: string | null): Record<string, string> {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const bindings: Record<string, string> = {};
  for (const [id, address] of Object.entries(parsed)) {
    if (!/^\d+$/.test(id) || typeof address !== 'string') {
      continue;
    }
    if (canonicalAddress(address) !== address) {
      continue;
    }
    bindings[id] = address;
  }
  return bindings;
}

export function withWidgetBinding(
  bindings: Record<string, string>,
  widgetId: number,
  address: string,
): Record<string, string> {
  const canonical = canonicalAddress(address);
  if (!canonical || !Number.isInteger(widgetId) || widgetId < 0) {
    return bindings;
  }
  return { ...bindings, [String(widgetId)]: canonical };
}

export function withoutWidgetBinding(
  bindings: Record<string, string>,
  widgetId: number,
): Record<string, string> {
  if (!Number.isInteger(widgetId)) {
    return bindings;
  }
  const next = { ...bindings };
  delete next[String(widgetId)];
  return next;
}

export async function readWidgetBindings(): Promise<Record<string, string>> {
  const { secureStore } = await import('./mwa');
  return parseWidgetBindings(await secureStore.getItem(WIDGET_BINDINGS_KEY));
}

export async function writeWidgetBindings(bindings: Record<string, string>): Promise<void> {
  const { secureStore } = await import('./mwa');
  await secureStore.setItem(WIDGET_BINDINGS_KEY, JSON.stringify(bindings));
}

export async function forgetWidgetBinding(widgetId: number): Promise<void> {
  const current = await readWidgetBindings();
  await writeWidgetBindings(withoutWidgetBinding(current, widgetId));
}

async function ledgerFor(
  client: ReturnType<typeof createClient>,
  mandate: MandateAccount,
): Promise<WidgetLedger> {
  const mandateKey = new PublicKey(mandate.address);
  try {
    const agentKey = new PublicKey(mandate.agent);
    const full = await fetchLedgerRows(client, mandateKey, agentKey);
    return { entries: full.rows };
  } catch {
    try {
      const snapshot = await fetchLedger(client, mandateKey);
      return { entries: snapshot.entries };
    } catch {
      return { error: true };
    }
  }
}

export async function loadWidgetBoard(nowMs: number): Promise<WidgetBoard> {
  const { secureStore } = await import('./mwa');
  const { tryLoadConfig } = await import('./config');
  const session = await loadSession(secureStore);
  if (!session) {
    return boardWithMessage(nowMs, 'empty', WIDGET_SIGNED_OUT_COPY);
  }
  const loaded = tryLoadConfig();
  if (!loaded.ok) {
    return boardWithMessage(nowMs, 'error', WIDGET_ERROR_COPY);
  }
  let owner: PublicKey;
  try {
    owner = new PublicKey(session.ownerPublicKey);
  } catch {
    return boardWithMessage(nowMs, 'error', WIDGET_ERROR_COPY);
  }
  const client = createClient(loaded.config);
  let mandates: MandateAccount[];
  try {
    mandates = await fetchOwnerMandates(client, owner);
  } catch (err) {
    return boardWithMessage(
      nowMs,
      'error',
      isRateLimitError(err) ? WIDGET_RATE_LIMIT_COPY : WIDGET_ERROR_COPY,
    );
  }
  let tradeRules: Awaited<ReturnType<typeof fetchOwnerTradeRules>> = [];
  try {
    tradeRules = await fetchOwnerTradeRules(client, owner);
  } catch (err) {
    if (mandates.length === 0) {
      return boardWithMessage(
        nowMs,
        'error',
        isRateLimitError(err) ? WIDGET_RATE_LIMIT_COPY : WIDGET_ERROR_COPY,
      );
    }
  }
  const shown = [...mandates, ...tradeRules.map((rule) => tradeRuleAsMandate(rule))];
  if (shown.length === 0) {
    return boardWithMessage(nowMs, 'empty', WIDGET_EMPTY_COPY);
  }
  const names = await loadAddressBook(secureStore);
  const selectedAddress = await secureStore.getItem(SELECTED_RULE_KEY);
  const ledgers = new Map<string, WidgetLedger>();
  const decimals = new Map<string, number>();
  for (const mandate of mandates) {
    ledgers.set(mandate.address, await ledgerFor(client, mandate));
    if (decimals.has(mandate.mint)) {
      continue;
    }
    try {
      decimals.set(mandate.mint, await fetchMintDecimals(client, new PublicKey(mandate.mint)));
    } catch {
      decimals.set(mandate.mint, loaded.config.mintDecimals);
    }
  }
  for (const rule of tradeRules) {
    try {
      const ledger = await fetchTradeLedgerRows(client, rule);
      ledgers.set(rule.address, { entries: ledger.rows });
    } catch {
      ledgers.set(rule.address, { error: true });
    }
    if (!decimals.has(rule.inMint)) {
      try {
        decimals.set(rule.inMint, await fetchMintDecimals(client, new PublicKey(rule.inMint)));
      } catch {
        decimals.set(rule.inMint, loaded.config.mintDecimals);
      }
    }
  }
  return assembleWidgetBoard({
    nowMs,
    mandates: shown,
    selectedAddress,
    names,
    ledgers,
    decimalsFor: (mandate) => decimals.get(mandate.mint) ?? loaded.config.mintDecimals,
  });
}
