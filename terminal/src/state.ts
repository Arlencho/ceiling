/** Terminal state: what the feed said at one moment, or that it said nothing.
 *
 * A down feed is a first-class state, not an error to swallow. When the feed
 * cannot be reached the state carries no window, no price and no quote, so
 * nothing downstream can accidentally render a stale number. HTTP 200 with a
 * missing hour or a bad body is not reported as unreachable.
 */

import { feedUrlFor, type FeedRead, type FeedStatus, type PriceFeed } from "../../watcher/src/feed.js";
import { quoteForWindow, type Quote } from "./quote.js";

export type StateWindow = {
  timeStart: string;
  timeEnd: string;
  sekPerKwh: string;
};

export type TerminalState = {
  feed: FeedStatus;
  sourceUrl: string;
  fetchedAt: string | null;
  refreshFailed: boolean;
  window: StateWindow | null;
  quote: Quote | null;
  note: string | null;
  httpStatus: number | null;
};

function noteFor(read: FeedRead, quote: Quote | null, unreadable: boolean): string | null {
  if (unreadable) {
    return "The fetched price could not be parsed, so there is no price and no quote.";
  }
  if (read.status === "unreachable") {
    return "The price feed could not be reached, so there is no price and no quote.";
  }
  if (read.status === "http_error") {
    return `The price feed answered with HTTP ${String(read.httpStatus)}, so there is no price and no quote.`;
  }
  if (read.status === "malformed") {
    return "The price feed answered, but the body could not be read, so there is no price and no quote.";
  }
  if (read.status === "missing_window") {
    return "The price feed has no entry for this hour, so there is no price and no quote.";
  }
  const parts: string[] = [];
  if (read.refreshFailed && read.readAt !== null) {
    parts.push(
      `A later read of the source failed. The price is from the last successful read at ${read.readAt.toISOString()}.`,
    );
  }
  if (quote === null) {
    parts.push("The fetched price is zero or negative, so no charge is quoted for this window.");
  }
  return parts.length === 0 ? null : parts.join(" ");
}

export async function buildState(args: {
  feed: PriceFeed;
  at: Date;
  kwhMilli: bigint;
  mintDecimals: number;
}): Promise<TerminalState> {
  const sourceUrl = feedUrlFor(args.at);

  let read: FeedRead;
  try {
    if (typeof args.feed.readWindow === "function") {
      read = await args.feed.readWindow(args.at);
    } else {
      const window = await args.feed.getWindow(args.at);
      read =
        window === null
          ? {
              status: "unreachable",
              sourceUrl,
              readAt: null,
              refreshFailed: false,
              window: null,
              httpStatus: null,
            }
          : {
              status: "ok",
              sourceUrl,
              readAt: args.at,
              refreshFailed: false,
              window,
              httpStatus: null,
            };
    }
  } catch {
    read = {
      status: "unreachable",
      sourceUrl,
      readAt: null,
      refreshFailed: true,
      window: null,
      httpStatus: null,
    };
  }

  let quote: Quote | null = null;
  let unreadable = false;
  if (read.window !== null) {
    try {
      quote = quoteForWindow({
        window: read.window,
        kwhMilli: args.kwhMilli,
        mintDecimals: args.mintDecimals,
      });
    } catch {
      unreadable = true;
      quote = null;
    }
  }

  const feed: FeedStatus = unreadable ? "malformed" : read.status;
  const window = unreadable || feed !== "ok" ? null : read.window;

  return {
    feed,
    sourceUrl: read.sourceUrl,
    fetchedAt: feed === "ok" && read.readAt !== null ? read.readAt.toISOString() : null,
    refreshFailed: read.refreshFailed,
    window,
    quote: unreadable ? null : quote,
    note: noteFor(read, quote, unreadable),
    httpStatus: read.httpStatus,
  };
}

export type QuoteEndpoints = {
  mint: string;
  merchantTokenAccount: string;
};

/** The JSON the agent reads. Amount and nonce are decimal strings of bigints. */
export function quoteResponse(
  state: TerminalState,
  endpoints: QuoteEndpoints,
): { status: number; body: Record<string, unknown> } {
  if (state.feed !== "ok" || state.quote === null) {
    return {
      status: 503,
      body: {
        error:
          state.feed === "unreachable"
            ? "price feed unreachable, no quote offered"
            : "no chargeable quote for this window",
        detail: state.note,
        source: state.sourceUrl,
      },
    };
  }
  return {
    status: 200,
    body: {
      amount: state.quote.amount.toString(),
      nonce: state.quote.nonce.toString(),
      window_start: state.quote.windowStart,
      window_end: state.quote.windowEnd,
      sek_per_kwh: state.quote.sekPerKwh,
      kwh_milli: state.quote.kwhMilli.toString(),
      mint: endpoints.mint,
      merchant_token_account: endpoints.merchantTokenAccount,
      source: state.sourceUrl,
    },
  };
}
