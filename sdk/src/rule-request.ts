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
