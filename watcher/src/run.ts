import type { PriceFeed, PriceWindow } from "./feed.js";
import type { JournalRow, JsonlJournal } from "./journal.js";
import { logError, logLine } from "./log.js";
import { amountBaseUnits, sekPerKwhToScaled } from "./money.js";
import { nonceFromWindowStart } from "./nonce.js";
import type { ChargeReceipt, RecoveredCharge } from "./chain.js";
import { REASON_STALE_NONCE } from "./reasons.js";
import { RateLimitedError, isRateLimitError } from "./rpc.js";

export type SubmitCharge = (amount: bigint, nonce: bigint) => Promise<ChargeReceipt>;

export type ProcessResult = "submitted" | "skipped" | "gap" | "deferred";

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
  log: (line: string) => void = logLine,
  failLog: (line: string) => void = logError,
): Promise<T> {
  let delay = RPC_INITIAL_MS;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isRateLimitError(err)) {
        log(`${label}: rpc rate limited: ${message}`);
        throw err instanceof RateLimitedError ? err : new RateLimitedError(`${label}: ${message}`);
      }
      failLog(`${label}: rpc failure, retry in ${delay}ms: ${message}`);
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

const RATE_LIMIT_GAP_REASON = "rpc rate limited on all endpoints";
const PAID_UNRECOVERED_REASON = "chain shows this window paid; signature could not be recovered";

function journalSignature(signature: string | null | undefined): string | null {
  if (signature === null || signature === undefined || signature.length === 0) return null;
  return signature;
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
  chainLastNonce?: () => Promise<bigint>;
  recoverSettled?: (nonce: bigint) => Promise<RecoveredCharge | null>;
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

  const deferRateLimit = (): ProcessResult => {
    if (!args.journal.hasGap(nonce)) {
      args.journal.append({
        ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount: 0n }),
        ...(window === null ? { window_start: args.at.toISOString() } : {}),
        decision: "gap",
        reason: RATE_LIMIT_GAP_REASON,
        reason_code: null,
        signature: null,
        suggested_override: null,
      });
    }
    log(
      `charge: rpc rate limited, window stays due nonce=${nonce.toString()} window=${window?.timeStart ?? args.at.toISOString()}`,
    );
    return "deferred";
  };

  const writeRecoveredPaid = (recovered: RecoveredCharge): ProcessResult => {
    args.journal.append({
      ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount: recovered.amount }),
      ...(window === null ? { window_start: args.at.toISOString() } : {}),
      decision: "paid",
      reason: recovered.reason,
      reason_code: recovered.reasonCode,
      signature: journalSignature(recovered.signature),
      suggested_override: recovered.suggestedOverride === null ? null : recovered.suggestedOverride.toString(),
    });
    log(
      `paid recovered amount=${recovered.amount.toString()} nonce=${nonce.toString()} sig=${recovered.signature.length > 0 ? recovered.signature : "-"}`,
    );
    return "submitted";
  };

  const writePaidUnrecovered = (amount: bigint): ProcessResult => {
    args.journal.append({
      ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount }),
      ...(window === null ? { window_start: args.at.toISOString() } : {}),
      decision: "paid",
      reason: PAID_UNRECOVERED_REASON,
      reason_code: 0,
      signature: null,
      suggested_override: null,
    });
    log(`paid unrecovered nonce=${nonce.toString()} window=${window?.timeStart ?? args.at.toISOString()}`);
    return "submitted";
  };

  const closeAlreadySettled = async (settled: bigint, amount: bigint): Promise<ProcessResult> => {
    if (args.recoverSettled) {
      const recovered = await args.recoverSettled(nonce);
      if (recovered !== null && recovered.decision === "paid") {
        return writeRecoveredPaid(recovered);
      }
    }
    if (nonce < settled) {
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
    return writePaidUnrecovered(amount);
  };

  // Settlement is read from the chain when a reader is provided. The journal
  // is only a cache: a rate limit after send leaves it empty, and using it
  // here would resubmit a nonce the program has already paid.
  let settled: bigint;
  if (args.chainLastNonce) {
    try {
      settled = await args.chainLastNonce();
    } catch (err) {
      if (isRateLimitError(err)) return deferRateLimit();
      throw err;
    }
  } else {
    settled = args.journal.maxSettledNonce();
  }

  if (nonce <= settled) {
    try {
      return await closeAlreadySettled(settled, 0n);
    } catch (err) {
      if (isRateLimitError(err)) return deferRateLimit();
      throw err;
    }
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

  let receipt: ChargeReceipt;
  try {
    receipt = await withRpcBackoff("charge", () => args.submit(amount, nonce), log);
  } catch (err) {
    if (isRateLimitError(err)) return deferRateLimit();
    throw err;
  }

  if (receipt.decision === "refused" && receipt.reasonCode === REASON_STALE_NONCE) {
    try {
      if (args.recoverSettled) {
        const recovered = await args.recoverSettled(nonce);
        if (recovered !== null && recovered.decision === "paid") {
          return writeRecoveredPaid(recovered);
        }
      }
    } catch (err) {
      if (isRateLimitError(err)) return deferRateLimit();
      throw err;
    }
    return writePaidUnrecovered(amount);
  }

  args.journal.append({
    ...rowBase({ window, nonce, kwhMilli: args.kwhMilli, amount }),
    decision: receipt.decision,
    reason: receipt.reason,
    reason_code: receipt.reasonCode,
    signature: journalSignature(receipt.signature),
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
