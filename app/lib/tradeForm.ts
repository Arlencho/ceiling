import { PublicKey } from '@solana/web3.js';

import { PURPOSE_MAX_LEN } from './constants';
import { parseBaseUnits } from './format';
import { canonicalAddress } from './ruleRequest';

export const DEFAULT_FLOOR_PERCENT = 90;

export type TradeFormInput = {
  agent: string;
  owner: string | null;
  poolId: string;
  poolIds: readonly string[];
  perTrade: string;
  perDay: string;
  total: string;
  floorPercent: string;
  days: string;
  purpose: string;
  decimals: number;
};

export type ValidTradeForm = {
  agent: string | null;
  poolId: string;
  perTradeMax: bigint;
  dailyLimit: bigint;
  cap: bigint;
  floorPercent: number;
  days: number;
  purpose: string;
};

export type TradeFormResult =
  | { ok: true; value: ValidTradeForm }
  | { ok: false; message: string };

function purposeLength(purpose: string): number {
  return Array.from(purpose).length;
}

export function floorPhrase(percent: number): string {
  return `at least ${percent} percent of today's rate`;
}

export function validateTradeForm(input: TradeFormInput): TradeFormResult {
  const poolId = input.poolId.trim();
  if (!input.poolIds.includes(poolId)) {
    return { ok: false, message: 'Pick a pool from the list.' };
  }

  const agentText = input.agent.trim();
  let agent: string | null = null;
  if (agentText.length > 0) {
    const canonical = canonicalAddress(agentText);
    if (!canonical) {
      return { ok: false, message: 'The agent address is not a Solana address.' };
    }
    const owner = input.owner ? canonicalAddress(input.owner) : null;
    if (owner && canonical === owner) {
      return { ok: false, message: 'The agent address is the owner. Pick the agent address.' };
    }
    try {
      if (new PublicKey(canonical).equals(PublicKey.default)) {
        return { ok: false, message: 'The agent address is not a Solana address.' };
      }
    } catch {
      return { ok: false, message: 'The agent address is not a Solana address.' };
    }
    agent = canonical;
  }

  let perTradeMax: bigint;
  let dailyLimit: bigint;
  let cap: bigint;
  try {
    perTradeMax = parseBaseUnits(input.perTrade, input.decimals);
    dailyLimit = parseBaseUnits(input.perDay, input.decimals);
    cap = parseBaseUnits(input.total, input.decimals);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Enter the amounts in the input token.';
    return { ok: false, message };
  }
  if (perTradeMax <= 0n || dailyLimit <= 0n || cap <= 0n) {
    return { ok: false, message: 'Most per trade, per day, and the total set aside must be above zero.' };
  }
  if (perTradeMax > dailyLimit) {
    return { ok: false, message: 'Most per trade is above the daily limit.' };
  }
  if (dailyLimit > cap) {
    return { ok: false, message: 'The daily limit is above the total set aside.' };
  }

  const percentText = input.floorPercent.trim();
  if (!/^\d+$/.test(percentText)) {
    return { ok: false, message: 'Floor percent must be a whole number from 1 to 100.' };
  }
  const floorPercent = Number.parseInt(percentText, 10);
  if (floorPercent < 1 || floorPercent > 100) {
    return { ok: false, message: 'Floor percent must be a whole number from 1 to 100.' };
  }

  const daysText = input.days.trim();
  if (!/^\d+$/.test(daysText)) {
    return { ok: false, message: 'Enter how many days this rule lasts.' };
  }
  const days = Number.parseInt(daysText, 10);
  if (days < 1 || days > 3650) {
    return { ok: false, message: 'Enter how many days this rule lasts.' };
  }

  const purpose = input.purpose.trim();
  const length = purposeLength(purpose);
  if (length === 0) {
    return { ok: false, message: 'Enter a purpose.' };
  }
  if (length > PURPOSE_MAX_LEN) {
    return { ok: false, message: `Purpose is longer than ${PURPOSE_MAX_LEN} characters.` };
  }

  return {
    ok: true,
    value: { agent, poolId, perTradeMax, dailyLimit, cap, floorPercent, days, purpose },
  };
}
