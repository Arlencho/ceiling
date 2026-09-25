import { PublicKey } from "@solana/web3.js";

/**
 * UTF-8 byte cap for `purpose`.
 * `programs/veto/src/state.rs` defines `PURPOSE_MAX_LEN` as 64 and sizes the
 * mandate string with `#[max_len(PURPOSE_MAX_LEN)]`, which reserves 64 bytes.
 * `open_mandate` also rejects more than that many characters. A purpose longer
 * than 64 bytes does not fit the account, so a request uses the byte cap.
 */
export const PURPOSE_MAX_BYTES = 64;

/** Unicode code points allowed in `agentLabel` and `payeeLabel`. */
export const LABEL_MAX_CHARS = 64;

export const RULE_REQUEST_DAYS_MIN = 1;
export const RULE_REQUEST_DAYS_MAX = 3650;

const U64_MAX = (1n << 64n) - 1n;

const QUERY_KEYS = [
  "v",
  "agent",
  "payee",
  "mint",
  "cap",
  "max",
  "days",
  "purpose",
  "agentLabel",
  "payeeLabel",
] as const;

type QueryKey = (typeof QUERY_KEYS)[number];

const QUERY_KEY_SET = new Set<string>(QUERY_KEYS);

/**
 * First-problem order for a rule request. Structural problems come before
 * fields, and fields are checked in the order they appear in the URL format.
 */
export const RULE_REQUEST_CHECK_ORDER = [
  "not_a_url",
  "scheme",
  "userinfo",
  "port",
  "host",
  "path",
  "duplicate_v",
  "missing_v",
  "bad_v",
  "duplicate_agent",
  "missing_agent",
  "bad_agent",
  "duplicate_payee",
  "missing_payee",
  "bad_payee",
  "duplicate_mint",
  "missing_mint",
  "bad_mint",
  "duplicate_cap",
  "missing_cap",
  "bad_cap",
  "duplicate_max",
  "missing_max",
  "bad_max",
  "max_above_cap",
  "duplicate_days",
  "missing_days",
  "bad_days",
  "duplicate_purpose",
  "missing_purpose",
  "bad_purpose",
  "purpose_too_long",
  "duplicate_agent_label",
  "bad_agent_label",
  "agent_label_too_long",
  "duplicate_payee_label",
  "bad_payee_label",
  "payee_label_too_long",
] as const;

export type RuleRequestProblem = (typeof RULE_REQUEST_CHECK_ORDER)[number];

export type RuleRequestError = {
  readonly problem: RuleRequestProblem;
  readonly message: string;
};

export type RuleRequest = {
  v: 1;
  agent: string;
  payee: string;
  mint: string;
  cap: bigint;
  max: bigint;
  days: number;
  purpose: string;
  agentLabel?: string;
  payeeLabel?: string;
};

export type RuleRequestInput = {
  agent: string;
  payee: string;
  mint: string;
  cap: bigint | number | string;
  max: bigint | number | string;
  days: bigint | number | string;
  purpose: string;
  agentLabel?: string;
  payeeLabel?: string;
};

export type ParsedRuleRequest =
  | { ok: true; request: RuleRequest }
  | { ok: false; error: RuleRequestError };

export class RuleRequestRejected extends Error {
  readonly problem: RuleRequestProblem;

  constructor(failure: RuleRequestError) {
    super(failure.message);
    this.name = "RuleRequestRejected";
    this.problem = failure.problem;
  }
}

const FIELD_NAME: Record<QueryKey, string> = {
  v: "version",
  agent: "agent",
  payee: "payee",
  mint: "mint",
  cap: "cap",
  max: "max",
  days: "days",
  purpose: "purpose",
  agentLabel: "agentLabel",
  payeeLabel: "payeeLabel",
};

type Slot = {
  count: number;
  value?: string;
  bad: boolean;
};

function fail(problem: RuleRequestProblem, message: string): RuleRequestError {
  return { problem, message };
}

function isFailure(value: unknown): value is RuleRequestError {
  return typeof value === "object" && value !== null && "problem" in value;
}

function amountMessage(noun: string): string {
  return `${noun} must be a base-unit integer greater than 0 and at most the u64 maximum`;
}

function daysMessage(): string {
  return `days must be an integer from ${RULE_REQUEST_DAYS_MIN} to ${RULE_REQUEST_DAYS_MAX}`;
}

function purposeTooLongMessage(): string {
  return `purpose is longer than ${PURPOSE_MAX_BYTES} bytes`;
}

function labelTooLongMessage(noun: string): string {
  return `${noun} is longer than ${LABEL_MAX_CHARS} characters`;
}

function canonicalAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function parsePositiveU64(raw: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const amount = BigInt(raw);
  if (amount > U64_MAX) return null;
  return amount;
}

function parseDaysToken(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < RULE_REQUEST_DAYS_MIN || days > RULE_REQUEST_DAYS_MAX) {
    return null;
  }
  return days;
}

function coercePositiveU64(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    if (value < 1n || value > U64_MAX) return null;
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return BigInt(value);
  }
  if (typeof value === "string") return parsePositiveU64(value);
  return null;
}

function coerceDays(value: unknown): number | null {
  if (typeof value === "bigint") {
    if (value < BigInt(RULE_REQUEST_DAYS_MIN) || value > BigInt(RULE_REQUEST_DAYS_MAX)) return null;
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < RULE_REQUEST_DAYS_MIN || value > RULE_REQUEST_DAYS_MAX) {
      return null;
    }
    return value;
  }
  if (typeof value === "string") return parseDaysToken(value);
  return null;
}

function codePointLength(value: string): number {
  return [...value].length;
}

/** Lone surrogates are not UTF-8. This target has no String.prototype.isWellFormed. */
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit >= 0xdc00 || i + 1 >= value.length) return false;
    const next = value.charCodeAt(i + 1);
    if (next < 0xdc00 || next > 0xdfff) return false;
    i += 1;
  }
  return true;
}

function purposeTooLong(value: string): boolean {
  return Buffer.byteLength(value, "utf8") > PURPOSE_MAX_BYTES;
}

/**
 * Query values use percent-encoding. A plus sign stays a plus sign, and a
 * space is %20. URLSearchParams would treat "+" as a space, so it is not used.
 */
function parseSlots(search: string): Map<QueryKey, Slot> {
  const slots = new Map<QueryKey, Slot>();
  const body = search.startsWith("?") ? search.slice(1) : search;
  if (body === "") return slots;
  for (const part of body.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      continue;
    }
    if (!QUERY_KEY_SET.has(key)) continue;
    const known = key as QueryKey;
    let slot = slots.get(known);
    if (!slot) {
      slot = { count: 0, bad: false };
      slots.set(known, slot);
    }
    slot.count += 1;
    if (slot.count > 1) continue;
    try {
      slot.value = decodeURIComponent(rawValue);
    } catch {
      slot.bad = true;
    }
  }
  return slots;
}

function readRequired(
  slots: Map<QueryKey, Slot>,
  key: QueryKey,
  duplicate: RuleRequestProblem,
  missing: RuleRequestProblem,
  bad: RuleRequestProblem,
  badMessage: string,
): string | RuleRequestError {
  const name = FIELD_NAME[key];
  const slot = slots.get(key);
  if (!slot || slot.count === 0) return fail(missing, `${name} is missing`);
  if (slot.count > 1) return fail(duplicate, `${name} is repeated`);
  if (slot.bad || slot.value === undefined) return fail(bad, badMessage);
  return slot.value;
}

function readOptional(
  slots: Map<QueryKey, Slot>,
  key: QueryKey,
  duplicate: RuleRequestProblem,
  bad: RuleRequestProblem,
  badMessage: string,
): string | undefined | RuleRequestError {
  const name = FIELD_NAME[key];
  const slot = slots.get(key);
  if (!slot || slot.count === 0) return undefined;
  if (slot.count > 1) return fail(duplicate, `${name} is repeated`);
  if (slot.bad || slot.value === undefined) return fail(bad, badMessage);
  return slot.value;
}

function readAddressField(
  slots: Map<QueryKey, Slot>,
  key: "agent" | "payee" | "mint",
  duplicate: RuleRequestProblem,
  missing: RuleRequestProblem,
  bad: RuleRequestProblem,
): string | RuleRequestError {
  const noun = FIELD_NAME[key];
  const message = `${noun} must be a canonical base58 address`;
  const raw = readRequired(slots, key, duplicate, missing, bad, message);
  if (isFailure(raw)) return raw;
  if (!canonicalAddress(raw)) return fail(bad, message);
  return raw;
}

function readAmountField(
  slots: Map<QueryKey, Slot>,
  key: "cap" | "max",
  duplicate: RuleRequestProblem,
  missing: RuleRequestProblem,
  bad: RuleRequestProblem,
): bigint | RuleRequestError {
  const message = amountMessage(FIELD_NAME[key]);
  const raw = readRequired(slots, key, duplicate, missing, bad, message);
  if (isFailure(raw)) return raw;
  const amount = parsePositiveU64(raw);
  if (amount === null) return fail(bad, message);
  return amount;
}

function readDaysField(slots: Map<QueryKey, Slot>): number | RuleRequestError {
  const message = daysMessage();
  const raw = readRequired(slots, "days", "duplicate_days", "missing_days", "bad_days", message);
  if (isFailure(raw)) return raw;
  const days = parseDaysToken(raw);
  if (days === null) return fail("bad_days", message);
  return days;
}

function readPurposeField(slots: Map<QueryKey, Slot>): string | RuleRequestError {
  const raw = readRequired(
    slots,
    "purpose",
    "duplicate_purpose",
    "missing_purpose",
    "bad_purpose",
    "purpose is not percent-encoded UTF-8",
  );
  if (isFailure(raw)) return raw;
  if (!isWellFormedUtf16(raw)) return fail("bad_purpose", "purpose is not percent-encoded UTF-8");
  if (purposeTooLong(raw)) return fail("purpose_too_long", purposeTooLongMessage());
  return raw;
}

function readLabelField(
  slots: Map<QueryKey, Slot>,
  key: "agentLabel" | "payeeLabel",
  duplicate: RuleRequestProblem,
  bad: RuleRequestProblem,
  tooLong: RuleRequestProblem,
): string | undefined | RuleRequestError {
  const noun = FIELD_NAME[key];
  const raw = readOptional(slots, key, duplicate, bad, `${noun} is not percent-encoded UTF-8`);
  if (isFailure(raw)) return raw;
  if (raw === undefined || raw === "") return undefined;
  if (!isWellFormedUtf16(raw)) return fail(bad, `${noun} is not percent-encoded UTF-8`);
  if (codePointLength(raw) > LABEL_MAX_CHARS) return fail(tooLong, labelTooLongMessage(noun));
  return raw;
}

function readFields(slots: Map<QueryKey, Slot>): RuleRequest | RuleRequestError {
  const version = readRequired(slots, "v", "duplicate_v", "missing_v", "bad_v", "version must be 1");
  if (isFailure(version)) return version;
  if (version !== "1") return fail("bad_v", "version must be 1");

  const agent = readAddressField(slots, "agent", "duplicate_agent", "missing_agent", "bad_agent");
  if (isFailure(agent)) return agent;
  const payee = readAddressField(slots, "payee", "duplicate_payee", "missing_payee", "bad_payee");
  if (isFailure(payee)) return payee;
  const mint = readAddressField(slots, "mint", "duplicate_mint", "missing_mint", "bad_mint");
  if (isFailure(mint)) return mint;

  const cap = readAmountField(slots, "cap", "duplicate_cap", "missing_cap", "bad_cap");
  if (isFailure(cap)) return cap;
  const max = readAmountField(slots, "max", "duplicate_max", "missing_max", "bad_max");
  if (isFailure(max)) return max;
  if (max > cap) return fail("max_above_cap", "max is greater than cap");

  const days = readDaysField(slots);
  if (isFailure(days)) return days;
  const purpose = readPurposeField(slots);
  if (isFailure(purpose)) return purpose;

  const agentLabel = readLabelField(slots, "agentLabel", "duplicate_agent_label", "bad_agent_label", "agent_label_too_long");
  if (isFailure(agentLabel)) return agentLabel;
  const payeeLabel = readLabelField(slots, "payeeLabel", "duplicate_payee_label", "bad_payee_label", "payee_label_too_long");
  if (isFailure(payeeLabel)) return payeeLabel;

  const request: RuleRequest = { v: 1, agent, payee, mint, cap, max, days, purpose };
  if (agentLabel !== undefined) request.agentLabel = agentLabel;
  if (payeeLabel !== undefined) request.payeeLabel = payeeLabel;
  return request;
}

function checkStructure(url: URL): RuleRequestError | undefined {
  if (url.protocol !== "veto:") return fail("scheme", "the scheme must be veto");
  if (url.username !== "" || url.password !== "") return fail("userinfo", "the request must not include user info");
  if (url.port !== "") return fail("port", "the request must not include a port");
  if (url.hostname.toLowerCase() !== "rule-request") return fail("host", "the host must be rule-request");
  if (url.pathname !== "" && url.pathname !== "/") return fail("path", "the path must be empty");
  return undefined;
}

function formatRequest(request: RuleRequest): string {
  const pairs: [string, string][] = [
    ["v", "1"],
    ["agent", request.agent],
    ["payee", request.payee],
    ["mint", request.mint],
    ["cap", request.cap.toString(10)],
    ["max", request.max.toString(10)],
    ["days", String(request.days)],
    ["purpose", request.purpose],
  ];
  if (request.agentLabel !== undefined && request.agentLabel !== "") pairs.push(["agentLabel", request.agentLabel]);
  if (request.payeeLabel !== undefined && request.payeeLabel !== "") pairs.push(["payeeLabel", request.payeeLabel]);
  const query = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `veto://rule-request?${query}`;
}

function readInputAddress(
  value: unknown,
  missing: RuleRequestProblem,
  bad: RuleRequestProblem,
  noun: string,
): string | RuleRequestError {
  if (value === undefined) return fail(missing, `${noun} is missing`);
  if (typeof value !== "string" || !canonicalAddress(value)) {
    return fail(bad, `${noun} must be a canonical base58 address`);
  }
  return value;
}

function readInputAmount(
  value: unknown,
  missing: RuleRequestProblem,
  bad: RuleRequestProblem,
  noun: string,
): bigint | RuleRequestError {
  if (value === undefined) return fail(missing, `${noun} is missing`);
  const amount = coercePositiveU64(value);
  if (amount === null) return fail(bad, amountMessage(noun));
  return amount;
}

function readInputDays(value: unknown): number | RuleRequestError {
  if (value === undefined) return fail("missing_days", "days is missing");
  const days = coerceDays(value);
  if (days === null) return fail("bad_days", daysMessage());
  return days;
}

function readInputPurpose(value: unknown): string | RuleRequestError {
  if (value === undefined) return fail("missing_purpose", "purpose is missing");
  if (typeof value !== "string" || !isWellFormedUtf16(value)) return fail("bad_purpose", "purpose must be UTF-8 text");
  if (purposeTooLong(value)) return fail("purpose_too_long", purposeTooLongMessage());
  return value;
}

function readInputLabel(
  value: unknown,
  bad: RuleRequestProblem,
  tooLong: RuleRequestProblem,
  noun: string,
): string | undefined | RuleRequestError {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isWellFormedUtf16(value)) return fail(bad, `${noun} must be UTF-8 text`);
  if (value === "") return undefined;
  if (codePointLength(value) > LABEL_MAX_CHARS) return fail(tooLong, labelTooLongMessage(noun));
  return value;
}

function readInput(input: RuleRequestInput): RuleRequest | RuleRequestError {
  const agent = readInputAddress(input.agent, "missing_agent", "bad_agent", "agent");
  if (isFailure(agent)) return agent;
  const payee = readInputAddress(input.payee, "missing_payee", "bad_payee", "payee");
  if (isFailure(payee)) return payee;
  const mint = readInputAddress(input.mint, "missing_mint", "bad_mint", "mint");
  if (isFailure(mint)) return mint;
  const cap = readInputAmount(input.cap, "missing_cap", "bad_cap", "cap");
  if (isFailure(cap)) return cap;
  const max = readInputAmount(input.max, "missing_max", "bad_max", "max");
  if (isFailure(max)) return max;
  if (max > cap) return fail("max_above_cap", "max is greater than cap");
  const days = readInputDays(input.days);
  if (isFailure(days)) return days;
  const purpose = readInputPurpose(input.purpose);
  if (isFailure(purpose)) return purpose;
  const agentLabel = readInputLabel(input.agentLabel, "bad_agent_label", "agent_label_too_long", "agentLabel");
  if (isFailure(agentLabel)) return agentLabel;
  const payeeLabel = readInputLabel(input.payeeLabel, "bad_payee_label", "payee_label_too_long", "payeeLabel");
  if (isFailure(payeeLabel)) return payeeLabel;
  const request: RuleRequest = { v: 1, agent, payee, mint, cap, max, days, purpose };
  if (agentLabel !== undefined) request.agentLabel = agentLabel;
  if (payeeLabel !== undefined) request.payeeLabel = payeeLabel;
  return request;
}

/**
 * Builds a `veto://rule-request` URL from the operator's limits.
 * Throws {@link RuleRequestRejected} naming the first problem.
 * An empty label is left off the URL.
 */
export function createRuleRequest(input: RuleRequestInput): string {
  const request = readInput(input);
  if (isFailure(request)) throw new RuleRequestRejected(request);
  return formatRequest(request);
}

/**
 * Reads a rule request URL. Unknown keys are ignored. A plus sign stays a
 * plus sign. The result is the request, or the first problem in
 * {@link RULE_REQUEST_CHECK_ORDER}.
 */
export function parseRuleRequest(url: string): ParsedRuleRequest {
  if (typeof url !== "string") {
    return { ok: false, error: fail("not_a_url", "the request is not a URL") };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: fail("not_a_url", "the request is not a URL") };
  }
  const structure = checkStructure(parsed);
  if (structure) return { ok: false, error: structure };
  const request = readFields(parseSlots(parsed.search));
  if (isFailure(request)) return { ok: false, error: request };
  return { ok: true, request };
}

const TRADE_QUERY_KEYS = [
  "v",
  "kind",
  "agent",
  "inMint",
  "outMint",
  "pool",
  "perTrade",
  "daily",
  "cap",
  "floorBps",
  "days",
  "purpose",
  "agentLabel",
  "poolLabel",
] as const;

type TradeQueryKey = (typeof TRADE_QUERY_KEYS)[number];

const TRADE_QUERY_KEY_SET = new Set<string>(TRADE_QUERY_KEYS);

/**
 * First-problem order for a trade rule request. A v1 reader never reaches
 * these: it stops at version, because version must be 1.
 */
export const TRADE_REQUEST_CHECK_ORDER = [
  "not_a_url",
  "scheme",
  "userinfo",
  "port",
  "host",
  "path",
  "duplicate_v",
  "missing_v",
  "bad_v",
  "duplicate_kind",
  "missing_kind",
  "bad_kind",
  "duplicate_agent",
  "missing_agent",
  "bad_agent",
  "duplicate_in_mint",
  "missing_in_mint",
  "bad_in_mint",
  "duplicate_out_mint",
  "missing_out_mint",
  "bad_out_mint",
  "duplicate_pool",
  "missing_pool",
  "bad_pool",
  "duplicate_per_trade",
  "missing_per_trade",
  "bad_per_trade",
  "duplicate_daily",
  "missing_daily",
  "bad_daily",
  "duplicate_cap",
  "missing_cap",
  "bad_cap",
  "limits_out_of_order",
  "duplicate_floor_bps",
  "missing_floor_bps",
  "bad_floor_bps",
  "duplicate_days",
  "missing_days",
  "bad_days",
  "duplicate_purpose",
  "missing_purpose",
  "bad_purpose",
  "purpose_too_long",
  "duplicate_agent_label",
  "bad_agent_label",
  "agent_label_too_long",
  "duplicate_pool_label",
  "bad_pool_label",
  "pool_label_too_long",
] as const;

export type TradeRequestProblem = (typeof TRADE_REQUEST_CHECK_ORDER)[number];

export type TradeRequestError = {
  readonly problem: TradeRequestProblem;
  readonly message: string;
};

export type TradeRuleRequest = {
  v: 2;
  kind: "trade";
  agent: string;
  inMint: string;
  outMint: string;
  pool: string;
  perTrade: bigint;
  daily: bigint;
  cap: bigint;
  floorBps: bigint;
  days: number;
  purpose: string;
  agentLabel?: string;
  poolLabel?: string;
};

export type TradeRuleRequestInput = {
  agent: string;
  inMint: string;
  outMint: string;
  pool: string;
  perTrade: bigint | number | string;
  daily: bigint | number | string;
  cap: bigint | number | string;
  floorBps: bigint | number | string;
  days: bigint | number | string;
  purpose: string;
  agentLabel?: string;
  poolLabel?: string;
};

export type ParsedTradeRuleRequest =
  | { ok: true; request: TradeRuleRequest }
  | { ok: false; error: TradeRequestError };

export class TradeRuleRequestRejected extends Error {
  readonly problem: TradeRequestProblem;

  constructor(failure: TradeRequestError) {
    super(failure.message);
    this.name = "TradeRuleRequestRejected";
    this.problem = failure.problem;
  }
}

const TRADE_FIELD_NAME: Record<TradeQueryKey, string> = {
  v: "version",
  kind: "kind",
  agent: "agent",
  inMint: "inMint",
  outMint: "outMint",
  pool: "pool",
  perTrade: "perTrade",
  daily: "daily",
  cap: "cap",
  floorBps: "floorBps",
  days: "days",
  purpose: "purpose",
  agentLabel: "agentLabel",
  poolLabel: "poolLabel",
};

const TRADE_DUPLICATE: Record<TradeQueryKey, TradeRequestProblem> = {
  v: "duplicate_v",
  kind: "duplicate_kind",
  agent: "duplicate_agent",
  inMint: "duplicate_in_mint",
  outMint: "duplicate_out_mint",
  pool: "duplicate_pool",
  perTrade: "duplicate_per_trade",
  daily: "duplicate_daily",
  cap: "duplicate_cap",
  floorBps: "duplicate_floor_bps",
  days: "duplicate_days",
  purpose: "duplicate_purpose",
  agentLabel: "duplicate_agent_label",
  poolLabel: "duplicate_pool_label",
};

const TRADE_MISSING: Record<Exclude<TradeQueryKey, "agentLabel" | "poolLabel">, TradeRequestProblem> = {
  v: "missing_v",
  kind: "missing_kind",
  agent: "missing_agent",
  inMint: "missing_in_mint",
  outMint: "missing_out_mint",
  pool: "missing_pool",
  perTrade: "missing_per_trade",
  daily: "missing_daily",
  cap: "missing_cap",
  floorBps: "missing_floor_bps",
  days: "missing_days",
  purpose: "missing_purpose",
};

const TRADE_BAD: Record<TradeQueryKey, TradeRequestProblem> = {
  v: "bad_v",
  kind: "bad_kind",
  agent: "bad_agent",
  inMint: "bad_in_mint",
  outMint: "bad_out_mint",
  pool: "bad_pool",
  perTrade: "bad_per_trade",
  daily: "bad_daily",
  cap: "bad_cap",
  floorBps: "bad_floor_bps",
  days: "bad_days",
  purpose: "bad_purpose",
  agentLabel: "bad_agent_label",
  poolLabel: "bad_pool_label",
};

function tradeFail(problem: TradeRequestProblem, message: string): TradeRequestError {
  return { problem, message };
}

function isTradeFailure(value: unknown): value is TradeRequestError {
  return typeof value === "object" && value !== null && "problem" in value;
}

function floorMessage(): string {
  return "floorBps must be an integer greater than 0 and at most the u64 maximum";
}

function parseTradeSlots(search: string): Map<TradeQueryKey, Slot> {
  const slots = new Map<TradeQueryKey, Slot>();
  const body = search.startsWith("?") ? search.slice(1) : search;
  if (body === "") return slots;
  for (const part of body.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      continue;
    }
    if (!TRADE_QUERY_KEY_SET.has(key)) continue;
    const known = key as TradeQueryKey;
    let slot = slots.get(known);
    if (!slot) {
      slot = { count: 0, bad: false };
      slots.set(known, slot);
    }
    slot.count += 1;
    if (slot.count > 1) continue;
    try {
      slot.value = decodeURIComponent(rawValue);
    } catch {
      slot.bad = true;
    }
  }
  return slots;
}

function readTradeRequired(
  slots: Map<TradeQueryKey, Slot>,
  key: Exclude<TradeQueryKey, "agentLabel" | "poolLabel">,
  badMessage: string,
): string | TradeRequestError {
  const name = TRADE_FIELD_NAME[key];
  const slot = slots.get(key);
  if (!slot || slot.count === 0) return tradeFail(TRADE_MISSING[key], `${name} is missing`);
  if (slot.count > 1) return tradeFail(TRADE_DUPLICATE[key], `${name} is repeated`);
  if (slot.bad || slot.value === undefined) return tradeFail(TRADE_BAD[key], badMessage);
  return slot.value;
}

function readTradeAddress(
  slots: Map<TradeQueryKey, Slot>,
  key: "agent" | "inMint" | "outMint" | "pool",
): string | TradeRequestError {
  const noun = TRADE_FIELD_NAME[key];
  const message = `${noun} must be a canonical base58 address`;
  const raw = readTradeRequired(slots, key, message);
  if (isTradeFailure(raw)) return raw;
  if (!canonicalAddress(raw)) return tradeFail(TRADE_BAD[key], message);
  return raw;
}

function readTradeAmount(
  slots: Map<TradeQueryKey, Slot>,
  key: "perTrade" | "daily" | "cap" | "floorBps",
): bigint | TradeRequestError {
  const message = key === "floorBps" ? floorMessage() : amountMessage(TRADE_FIELD_NAME[key]);
  const raw = readTradeRequired(slots, key, message);
  if (isTradeFailure(raw)) return raw;
  const amount = parsePositiveU64(raw);
  if (amount === null) return tradeFail(TRADE_BAD[key], message);
  return amount;
}

function readTradeDays(slots: Map<TradeQueryKey, Slot>): number | TradeRequestError {
  const message = daysMessage();
  const raw = readTradeRequired(slots, "days", message);
  if (isTradeFailure(raw)) return raw;
  const days = parseDaysToken(raw);
  if (days === null) return tradeFail("bad_days", message);
  return days;
}

function readTradePurpose(slots: Map<TradeQueryKey, Slot>): string | TradeRequestError {
  const raw = readTradeRequired(slots, "purpose", "purpose is not percent-encoded UTF-8");
  if (isTradeFailure(raw)) return raw;
  if (!isWellFormedUtf16(raw)) return tradeFail("bad_purpose", "purpose is not percent-encoded UTF-8");
  if (purposeTooLong(raw)) return tradeFail("purpose_too_long", purposeTooLongMessage());
  return raw;
}

function readTradeLabel(
  slots: Map<TradeQueryKey, Slot>,
  key: "agentLabel" | "poolLabel",
  tooLong: TradeRequestProblem,
): string | undefined | TradeRequestError {
  const noun = TRADE_FIELD_NAME[key];
  const slot = slots.get(key);
  if (!slot || slot.count === 0) return undefined;
  if (slot.count > 1) return tradeFail(TRADE_DUPLICATE[key], `${noun} is repeated`);
  if (slot.bad || slot.value === undefined) {
    return tradeFail(TRADE_BAD[key], `${noun} is not percent-encoded UTF-8`);
  }
  if (!isWellFormedUtf16(slot.value)) return tradeFail(TRADE_BAD[key], `${noun} is not percent-encoded UTF-8`);
  if (slot.value === "") return undefined;
  if (codePointLength(slot.value) > LABEL_MAX_CHARS) return tradeFail(tooLong, labelTooLongMessage(noun));
  return slot.value;
}

function readTradeFields(slots: Map<TradeQueryKey, Slot>): TradeRuleRequest | TradeRequestError {
  const version = readTradeRequired(slots, "v", "version must be 2");
  if (isTradeFailure(version)) return version;
  if (version !== "2") return tradeFail("bad_v", "version must be 2");

  const kind = readTradeRequired(slots, "kind", "kind must be trade");
  if (isTradeFailure(kind)) return kind;
  if (kind !== "trade") return tradeFail("bad_kind", "kind must be trade");

  const agent = readTradeAddress(slots, "agent");
  if (isTradeFailure(agent)) return agent;
  const inMint = readTradeAddress(slots, "inMint");
  if (isTradeFailure(inMint)) return inMint;
  const outMint = readTradeAddress(slots, "outMint");
  if (isTradeFailure(outMint)) return outMint;
  const pool = readTradeAddress(slots, "pool");
  if (isTradeFailure(pool)) return pool;

  const perTrade = readTradeAmount(slots, "perTrade");
  if (isTradeFailure(perTrade)) return perTrade;
  const daily = readTradeAmount(slots, "daily");
  if (isTradeFailure(daily)) return daily;
  const cap = readTradeAmount(slots, "cap");
  if (isTradeFailure(cap)) return cap;
  if (perTrade > daily) return tradeFail("limits_out_of_order", "perTrade is greater than daily");
  if (daily > cap) return tradeFail("limits_out_of_order", "daily is greater than cap");

  const floorBps = readTradeAmount(slots, "floorBps");
  if (isTradeFailure(floorBps)) return floorBps;
  const days = readTradeDays(slots);
  if (isTradeFailure(days)) return days;
  const purpose = readTradePurpose(slots);
  if (isTradeFailure(purpose)) return purpose;
  const agentLabel = readTradeLabel(slots, "agentLabel", "agent_label_too_long");
  if (isTradeFailure(agentLabel)) return agentLabel;
  const poolLabel = readTradeLabel(slots, "poolLabel", "pool_label_too_long");
  if (isTradeFailure(poolLabel)) return poolLabel;

  const request: TradeRuleRequest = {
    v: 2,
    kind: "trade",
    agent,
    inMint,
    outMint,
    pool,
    perTrade,
    daily,
    cap,
    floorBps,
    days,
    purpose,
  };
  if (agentLabel !== undefined) request.agentLabel = agentLabel;
  if (poolLabel !== undefined) request.poolLabel = poolLabel;
  return request;
}

function formatTradeRequest(request: TradeRuleRequest): string {
  const pairs: [string, string][] = [
    ["v", "2"],
    ["kind", "trade"],
    ["agent", request.agent],
    ["inMint", request.inMint],
    ["outMint", request.outMint],
    ["pool", request.pool],
    ["perTrade", request.perTrade.toString(10)],
    ["daily", request.daily.toString(10)],
    ["cap", request.cap.toString(10)],
    ["floorBps", request.floorBps.toString(10)],
    ["days", String(request.days)],
    ["purpose", request.purpose],
  ];
  if (request.agentLabel !== undefined && request.agentLabel !== "") pairs.push(["agentLabel", request.agentLabel]);
  if (request.poolLabel !== undefined && request.poolLabel !== "") pairs.push(["poolLabel", request.poolLabel]);
  const query = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `veto://rule-request?${query}`;
}

function readTradeInputAddress(
  value: unknown,
  missing: TradeRequestProblem,
  bad: TradeRequestProblem,
  noun: string,
): string | TradeRequestError {
  if (value === undefined) return tradeFail(missing, `${noun} is missing`);
  if (typeof value !== "string" || !canonicalAddress(value)) {
    return tradeFail(bad, `${noun} must be a canonical base58 address`);
  }
  return value;
}

function readTradeInputAmount(
  value: unknown,
  missing: TradeRequestProblem,
  bad: TradeRequestProblem,
  noun: string,
  message: string,
): bigint | TradeRequestError {
  if (value === undefined) return tradeFail(missing, `${noun} is missing`);
  const amount = coercePositiveU64(value);
  if (amount === null) return tradeFail(bad, message);
  return amount;
}

function readTradeInputLabel(
  value: unknown,
  bad: TradeRequestProblem,
  tooLong: TradeRequestProblem,
  noun: string,
): string | undefined | TradeRequestError {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isWellFormedUtf16(value)) return tradeFail(bad, `${noun} must be UTF-8 text`);
  if (value === "") return undefined;
  if (codePointLength(value) > LABEL_MAX_CHARS) return tradeFail(tooLong, labelTooLongMessage(noun));
  return value;
}

function tradeStructure(url: URL): TradeRequestError | undefined {
  const structure = checkStructure(url);
  if (!structure) return undefined;
  if (
    structure.problem === "scheme" ||
    structure.problem === "userinfo" ||
    structure.problem === "port" ||
    structure.problem === "host" ||
    structure.problem === "path"
  ) {
    return { problem: structure.problem, message: structure.message };
  }
  return tradeFail("not_a_url", structure.message);
}

function readTradeInput(input: TradeRuleRequestInput): TradeRuleRequest | TradeRequestError {
  const agent = readTradeInputAddress(input.agent, "missing_agent", "bad_agent", "agent");
  if (isTradeFailure(agent)) return agent;
  const inMint = readTradeInputAddress(input.inMint, "missing_in_mint", "bad_in_mint", "inMint");
  if (isTradeFailure(inMint)) return inMint;
  const outMint = readTradeInputAddress(input.outMint, "missing_out_mint", "bad_out_mint", "outMint");
  if (isTradeFailure(outMint)) return outMint;
  const pool = readTradeInputAddress(input.pool, "missing_pool", "bad_pool", "pool");
  if (isTradeFailure(pool)) return pool;
  const perTrade = readTradeInputAmount(input.perTrade, "missing_per_trade", "bad_per_trade", "perTrade", amountMessage("perTrade"));
  if (isTradeFailure(perTrade)) return perTrade;
  const daily = readTradeInputAmount(input.daily, "missing_daily", "bad_daily", "daily", amountMessage("daily"));
  if (isTradeFailure(daily)) return daily;
  const cap = readTradeInputAmount(input.cap, "missing_cap", "bad_cap", "cap", amountMessage("cap"));
  if (isTradeFailure(cap)) return cap;
  if (perTrade > daily) return tradeFail("limits_out_of_order", "perTrade is greater than daily");
  if (daily > cap) return tradeFail("limits_out_of_order", "daily is greater than cap");
  const floorBps = readTradeInputAmount(input.floorBps, "missing_floor_bps", "bad_floor_bps", "floorBps", floorMessage());
  if (isTradeFailure(floorBps)) return floorBps;
  if (input.days === undefined) return tradeFail("missing_days", "days is missing");
  const days = coerceDays(input.days);
  if (days === null) return tradeFail("bad_days", daysMessage());
  if (input.purpose === undefined) return tradeFail("missing_purpose", "purpose is missing");
  if (typeof input.purpose !== "string" || !isWellFormedUtf16(input.purpose)) {
    return tradeFail("bad_purpose", "purpose must be UTF-8 text");
  }
  if (purposeTooLong(input.purpose)) return tradeFail("purpose_too_long", purposeTooLongMessage());
  const agentLabel = readTradeInputLabel(input.agentLabel, "bad_agent_label", "agent_label_too_long", "agentLabel");
  if (isTradeFailure(agentLabel)) return agentLabel;
  const poolLabel = readTradeInputLabel(input.poolLabel, "bad_pool_label", "pool_label_too_long", "poolLabel");
  if (isTradeFailure(poolLabel)) return poolLabel;
  const request: TradeRuleRequest = {
    v: 2,
    kind: "trade",
    agent,
    inMint,
    outMint,
    pool,
    perTrade,
    daily,
    cap,
    floorBps,
    days,
    purpose: input.purpose,
  };
  if (agentLabel !== undefined) request.agentLabel = agentLabel;
  if (poolLabel !== undefined) request.poolLabel = poolLabel;
  return request;
}

/**
 * Builds a v2 `veto://rule-request` URL for one pinned pool.
 * Throws {@link TradeRuleRequestRejected} naming the first problem.
 * An empty label is left off the URL.
 */
export function createTradeRuleRequest(input: TradeRuleRequestInput): string {
  const request = readTradeInput(input);
  if (isTradeFailure(request)) throw new TradeRuleRequestRejected(request);
  return formatTradeRequest(request);
}

/**
 * Reads a v2 trade rule request. Unknown keys are ignored.
 * A v1 reader ({@link parseRuleRequest}) rejects the same URL at version.
 */
export function parseTradeRuleRequest(url: string): ParsedTradeRuleRequest {
  if (typeof url !== "string") {
    return { ok: false, error: tradeFail("not_a_url", "the request is not a URL") };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: tradeFail("not_a_url", "the request is not a URL") };
  }
  const structure = tradeStructure(parsed);
  if (structure) return { ok: false, error: structure };
  const request = readTradeFields(parseTradeSlots(parsed.search));
  if (isTradeFailure(request)) return { ok: false, error: request };
  return { ok: true, request };
}
