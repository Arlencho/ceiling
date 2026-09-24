import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { PURPOSE_MAX_LEN } from './constants';

const U64_MAX = 18446744073709551615n;
const REQUIRED_KEYS = ['v', 'agent', 'payee', 'mint', 'cap', 'max', 'days', 'purpose'] as const;
const OPTIONAL_KEYS = ['agentLabel', 'payeeLabel'] as const;
const KNOWN_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
// Purpose is capped in UTF-8 bytes (the account stores PURPOSE_MAX_LEN bytes).
// Labels are capped in Unicode code points.
const LABEL_MAX_CHARS = 64;

export type RuleRequestV1 = {
  v: 1;
  agent: string;
  payee: string;
  mint: string;
  cap: bigint;
  max: bigint;
  days: number;
  purpose: string;
  agentLabel: string | null;
  payeeLabel: string | null;
};

export type ParsedRuleRequest =
  | { ok: true; request: RuleRequestV1 }
  | { ok: false; reason: string };

export function canonicalAddress(text: string): string | null {
  let key: PublicKey;
  try {
    key = new PublicKey(text);
  } catch {
    return null;
  }
  const canonical = key.toBase58();
  if (canonical !== text) {
    return null;
  }
  return canonical;
}

export function isRuleRequestUrl(input: string): boolean {
  const withoutHash = stripHash(input.trim());
  return /^veto:\/\/rule-request\/?(?:\?.*)?$/i.test(withoutHash);
}

export function ruleRequestHref(url: string): string | null {
  const trimmed = url.trim();
  if (!isRuleRequestUrl(trimmed)) {
    return null;
  }
  return `/rule-request?url=${encodeURIComponent(trimmed)}`;
}

export function readScannedText(
  raw: string,
): { kind: 'request'; url: string } | { kind: 'address'; address: string } | { kind: 'invalid'; reason: string } {
  const text = raw.trim();
  if (isRuleRequestUrl(text)) {
    return { kind: 'request', url: text };
  }
  const address = canonicalAddress(text);
  if (address) {
    return { kind: 'address', address };
  }
  return { kind: 'invalid', reason: 'That code is not a rule request or an address.' };
}

export function parseRuleRequest(input: string): ParsedRuleRequest {
  const trimmed = input.trim();
  if (!isRuleRequestUrl(trimmed)) {
    return { ok: false, reason: 'This is not a rule request.' };
  }
  const withoutHash = stripHash(trimmed);
  const queryIndex = withoutHash.indexOf('?');
  const query = queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1);
  let pairs: Map<string, string[]>;
  try {
    pairs = parseQuery(query);
  } catch {
    return { ok: false, reason: 'The request is not percent-encoded UTF-8.' };
  }
  return requestFromPairs(pairs);
}

export function ruleRequestFromParams(
  params: Record<string, string | string[] | undefined>,
): ParsedRuleRequest {
  const pairs = new Map<string, string[]>();
  for (const key of KNOWN_KEYS) {
    const value = params[key];
    if (value == null) {
      continue;
    }
    const list = Array.isArray(value) ? value : [value];
    pairs.set(key, list);
  }
  return requestFromPairs(pairs);
}

function requestFromPairs(pairs: Map<string, string[]>): ParsedRuleRequest {
  for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
    const values = pairs.get(key);
    if (values && values.length > 1) {
      return { ok: false, reason: `The request repeats ${key}.` };
    }
  }
  for (const key of REQUIRED_KEYS) {
    const value = pairs.get(key)?.[0];
    // An empty purpose is a purpose. Every other required field must be present and non-empty.
    if (value == null || (key !== 'purpose' && value.length === 0)) {
      return { ok: false, reason: `The request is missing ${key}.` };
    }
  }
  if (pairs.get('v')?.[0] !== '1') {
    return { ok: false, reason: 'The request version is not 1.' };
  }
  const agent = canonicalAddress(pairs.get('agent')?.[0] ?? '');
  if (!agent) {
    return { ok: false, reason: 'The agent address is not canonical.' };
  }
  const payee = canonicalAddress(pairs.get('payee')?.[0] ?? '');
  if (!payee) {
    return { ok: false, reason: 'The payee address is not canonical.' };
  }
  const mint = canonicalAddress(pairs.get('mint')?.[0] ?? '');
  if (!mint) {
    return { ok: false, reason: 'The mint address is not canonical.' };
  }
  const cap = parseBaseUnitAmount(pairs.get('cap')?.[0] ?? '');
  if (cap == null) {
    return { ok: false, reason: 'The cap is not a whole number of base units.' };
  }
  if (cap === 0n) {
    return { ok: false, reason: 'The cap is zero.' };
  }
  const max = parseBaseUnitAmount(pairs.get('max')?.[0] ?? '');
  if (max == null) {
    return { ok: false, reason: 'The max is not a whole number of base units.' };
  }
  if (max === 0n) {
    return { ok: false, reason: 'The largest payment is zero.' };
  }
  if (max > cap) {
    return { ok: false, reason: 'The largest payment is above the cap.' };
  }
  const days = parseDays(pairs.get('days')?.[0] ?? '');
  if (days == null) {
    return { ok: false, reason: 'The days value must be a whole number of days from 1 to 3650.' };
  }
  const purpose = pairs.get('purpose')?.[0] ?? '';
  if (!isWellFormedUtf16(purpose)) {
    return { ok: false, reason: 'The purpose is not percent-encoded UTF-8.' };
  }
  if (Buffer.byteLength(purpose, 'utf8') > PURPOSE_MAX_LEN) {
    return { ok: false, reason: `The purpose is longer than ${PURPOSE_MAX_LEN} bytes.` };
  }
  const agentLabel = readLabel(pairs.get('agentLabel'), 'agent label');
  if (isRejected(agentLabel)) {
    return agentLabel;
  }
  const payeeLabel = readLabel(pairs.get('payeeLabel'), 'payee label');
  if (isRejected(payeeLabel)) {
    return payeeLabel;
  }
  return {
    ok: true,
    request: {
      v: 1,
      agent,
      payee,
      mint,
      cap,
      max,
      days,
      purpose,
      agentLabel,
      payeeLabel,
    },
  };
}

function readLabel(
  values: string[] | undefined,
  noun: 'agent label' | 'payee label',
): string | null | { ok: false; reason: string } {
  const value = values?.[0] ?? '';
  if (value.length === 0) {
    return null;
  }
  if (!isWellFormedUtf16(value)) {
    return { ok: false, reason: `The ${noun} is not percent-encoded UTF-8.` };
  }
  if (Array.from(value).length > LABEL_MAX_CHARS) {
    return { ok: false, reason: `The ${noun} is longer than ${LABEL_MAX_CHARS} characters.` };
  }
  return value;
}

function isRejected(value: string | null | { ok: false; reason: string }): value is { ok: false; reason: string } {
  return typeof value === 'object' && value !== null;
}

// Lone surrogates are not UTF-8. decodeURIComponent rejects bad percent-encoding,
// and this catches a string that arrived already decoded.
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) {
      continue;
    }
    if (unit >= 0xdc00 || i + 1 >= value.length) {
      return false;
    }
    const next = value.charCodeAt(i + 1);
    if (next < 0xdc00 || next > 0xdfff) {
      return false;
    }
    i += 1;
  }
  return true;
}

function parseBaseUnitAmount(raw: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    return null;
  }
  const value = BigInt(raw);
  if (value > U64_MAX) {
    return null;
  }
  return value;
}

function parseDays(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return null;
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    return null;
  }
  return days;
}

function stripHash(input: string): string {
  const hash = input.indexOf('#');
  return hash === -1 ? input : input.slice(0, hash);
}

function parseQuery(query: string): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  if (query.length === 0) {
    return pairs;
  }
  for (const part of query.split('&')) {
    if (part.length === 0) {
      continue;
    }
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // An unknown key that is not UTF-8 is ignored, same as any other unknown key.
      continue;
    }
    if (!KNOWN_KEYS.has(key)) {
      continue;
    }
    const value = decodeURIComponent(rawValue);
    const list = pairs.get(key) ?? [];
    list.push(value);
    pairs.set(key, list);
  }
  return pairs;
}
