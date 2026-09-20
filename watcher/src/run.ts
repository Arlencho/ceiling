import type { PriceFeed, PriceWindow } from "./feed.js";
import type { JournalRow, JsonlJournal } from "./journal.js";
import { logError, logLine } from "./log.js";
import { amountBaseUnits, sekPerKwhToScaled } from "./money.js";
import { nonceFromWindowStart } from "./nonce.js";
import type { ChargeReceipt } from "./chain.js";

export type SubmitCharge = (amount: bigint, nonce: bigint) => Promise<ChargeReceipt>;

export type ProcessResult = "submitted" | "skipped" | "gap";

const FEED_ATTEMPTS = 5;
const FEED_RETRY_MS = 2_000;
const RPC_INITIAL_MS = 1_000;
const RPC_MAX_MS = 60_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRpcBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  log: (line: string) => void = logError,
): Promise<T> {
  let delay = RPC_INITIAL_MS;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${label}: rpc failure, retry in ${delay}ms: ${message}`);
      await sleep(delay);
      delay = delay * 2 > RPC_MAX_MS ? RPC_MAX_MS : delay * 2;
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowBase(args: {
  window: PriceWindow | null;
  nonce: bigint;
  kwhMilli: bigint;
  amount: bigint;
}): Pick<JournalRow, "ts" | "window_start" | "window_end" | "sek_per_kwh" | "kwh_milli" | "amount" | "nonce"> {
  return {
    ts: nowIso(),
    window_start: args.window?.timeStart ?? "",
    window_end: args.window?.timeEnd ?? null,
    sek_per_kwh: args.window?.sekPerKwh ?? null,
    kwh_milli: args.kwhMilli.toString(),
    amount: args.amount.toString(),
    nonce: args.nonce.toString(),
  };
}

export async function processWindow(args: {
  at: Date;
  feed: PriceFeed;
  journal: JsonlJournal;
  submit: SubmitCharge;
  kwhMilli: bigint;
  mintDecimals: number;
  log?: (line: string) => void;
  feedAttempts?: number;
  feedRetryMs?: number;
}): Promise<ProcessResult> {
  const log = args.log ?? logLine;
  const feedAttempts = args.feedAttempts ?? FEED_ATTEMPTS;
  const feedRetryMs = args.feedRetryMs ?? FEED_RETRY_MS;

  let window: PriceWindow | null = null;
  for (let attempt = 1; attempt <= feedAttempts; attempt += 1) {
    window = await args.feed.getWindow(args.at);
    if (window !== null) break;
    if (attempt < feedAttempts) await sleep(feedRetryMs);
  }

  const nonce = nonceFromWindowStart(window === null ? args.at.toISOString() : window.timeStart);
  if (args.journal.hasNonce(nonce)) {
    if (window !== null) {
      log(`skipped already decided nonce=${nonce.toString()} window=${window.timeStart}`);
    }
    return "skipped";
  }

  // A later window already paid on chain, so this one can never pay:
  // only a payment advances last_nonce. Close it honestly rather than
  // submitting a charge whose only possible outcome is a replay refusal.
  // This check sits before the feed-up / feed-down branch so a recovered
  // feed cannot resubmit an overtaken gap.
  if (nonce <= args.journal.maxSettledNonce()) {
    args.journal.append({
      ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount: 0n }),
      ...(window === null ? { window_start: args.at.toISOString() } : {}),
      decision: "skipped",
      reason: "window overtaken by a later settled charge",
      reason_code: null,
      signature: null,
      suggested_override: null,
    });
    log(`skipped overtaken window at=${args.at.toISOString()}`);
    return "skipped";
  }

  if (window === null) {
    // Record the outage once, then leave the window retryable so a later cycle
    // can still submit it when the feed comes back.
    if (args.journal.hasGap(nonce)) {
      log(`gap feed still unavailable at=${args.at.toISOString()}, window stays due`);
      return "gap";
    }
    args.journal.append({
      ...rowBase({ window: null, nonce, kwhMilli: args.kwhMilli, amount: 0n }),
      window_start: args.at.toISOString(),
      decision: "gap",
      reason: "feed unavailable",
      reason_code: null,
      signature: null,
      suggested_override: null,
    });
    log(`gap feed unavailable at=${args.at.toISOString()}`);
    return "gap";
  }

  let scaled: bigint;
  try {
    scaled = sekPerKwhToScaled(window.sekPerKwh);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.journal.hasGap(nonce)) {
      log(
        `gap unreadable price still at window=${window.timeStart} sek=${window.sekPerKwh}, window stays due`,
      );
      return "gap";
    }
    args.journal.append({
      ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount: 0n }),
      decision: "gap",
      reason: `unreadable price: ${message}`,
      reason_code: null,
      signature: null,
      suggested_override: null,
    });
    log(`gap unreadable price window=${window.timeStart} sek=${window.sekPerKwh}`);
    return "gap";
  }

  if (scaled < 0n) {
    args.journal.append({
      ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount: 0n }),
      decision: "skipped",
      reason: "negative price",
      reason_code: null,
      signature: null,
      suggested_override: null,
    });
    log(`skipped negative price window=${window.timeStart} sek=${window.sekPerKwh}`);
    return "skipped";
  }

  const amount = amountBaseUnits({
    kwhMilli: args.kwhMilli,
    sekPerKwhScaled: scaled,
    mintDecimals: args.mintDecimals,
  });

  if (amount === 0n) {
    args.journal.append({
      ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount }),
      decision: "skipped",
      reason: "zero amount",
      reason_code: null,
      signature: null,
      suggested_override: null,
    });
    log(`skipped zero amount window=${window.timeStart} sek=${window.sekPerKwh}`);
    return "skipped";
  }

  const receipt = await withRpcBackoff("charge", () => args.submit(amount, nonce), logError);
  args.journal.append({
    ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount }),
    decision: receipt.decision,
    reason: receipt.reason,
    reason_code: receipt.reasonCode,
    signature: receipt.signature,
    suggested_override: receipt.suggestedOverride === null ? null : receipt.suggestedOverride.toString(),
  });

  if (receipt.decision === "refused") {
    log(
      `refused reason=${receipt.reason} amount=${amount.toString()} nonce=${nonce.toString()} window=${window.timeStart} sig=${receipt.signature}`,
    );
  } else {
    log(
      `paid amount=${amount.toString()} nonce=${nonce.toString()} window=${window.timeStart} sig=${receipt.signature}`,
    );
  }
  return "submitted";
}
