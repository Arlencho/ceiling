import { Buffer } from 'buffer';

import {
  buffersEqual,
  CHARGE_IX_DISC,
  GRANT_OVERRIDE_DISC,
  KIND_OPENED,
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  KIND_REVOKED,
  OPEN_MANDATE_DISC,
  PAID_EVENT_DISC,
  readU64Le,
  REFUSED_EVENT_DISC,
  REVOKE_MANDATE_DISC,
} from './constants';
import type { DecodedTxDecision } from './ring';

const PROGRAM_DATA = /^Program data: ([A-Za-z0-9+/=]+)$/;

export function decodeEventsFromLogs(
  signature: string,
  logs: readonly string[],
): DecodedTxDecision[] {
  const out: DecodedTxDecision[] = [];
  for (const line of logs) {
    const match = PROGRAM_DATA.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const raw = Buffer.from(match[1], 'base64');
    const event = decodeEventBytes(signature, raw);
    if (event) {
      out.push(event);
    }
  }
  return out;
}

export function decodeEventBytes(signature: string, raw: Uint8Array): DecodedTxDecision | null {
  if (raw.length < 8) {
    return null;
  }
  const disc = raw.subarray(0, 8);
  if (buffersEqual(disc, PAID_EVENT_DISC)) {
    if (raw.length < 64) {
      return null;
    }
    return {
      signature,
      kind: KIND_PAID,
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: 0,
    };
  }
  if (buffersEqual(disc, REFUSED_EVENT_DISC)) {
    if (raw.length < 65) {
      return null;
    }
    return {
      signature,
      kind: KIND_REFUSED,
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: raw[56] ?? 0,
      suggestedOverride: readU64Le(raw, 57),
    };
  }
  return null;
}

export function decodeInstructionKind(
  signature: string,
  data: Uint8Array,
): DecodedTxDecision | null {
  if (data.length < 8) {
    return null;
  }
  const disc = data.subarray(0, 8);
  if (buffersEqual(disc, OPEN_MANDATE_DISC)) {
    return { signature, kind: KIND_OPENED, amount: 0n, nonce: 0n, reason: 0 };
  }
  if (buffersEqual(disc, REVOKE_MANDATE_DISC)) {
    return { signature, kind: KIND_REVOKED, amount: 0n, nonce: 0n, reason: 0 };
  }
  if (buffersEqual(disc, GRANT_OVERRIDE_DISC)) {
    if (data.length < 24) {
      return { signature, kind: KIND_OVERRIDE, amount: 0n, nonce: 0n, reason: 0 };
    }
    return {
      signature,
      kind: KIND_OVERRIDE,
      amount: readU64Le(data, 8),
      nonce: readU64Le(data, 16),
      reason: 0,
    };
  }
  if (buffersEqual(disc, CHARGE_IX_DISC)) {
    return null;
  }
  return null;
}
