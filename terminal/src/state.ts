/** Terminal state: what the feed said at one moment, or that it said nothing.
 *
 * A down feed is a first-class state, not an error to swallow. When the feed
 * cannot be reached the state carries no window, no price and no quote, so
 * nothing downstream can accidentally render a stale number.
 */

import { feedUrlFor, type PriceFeed } from "../../watcher/src/feed.js";
import { quoteForWindow, type Quote } from "./quote.js";

export type StateWindow = {
  timeStart: string;
  timeEnd: string;
  sekPerKwh: string;
};

export type TerminalState = {
  feed: "ok" | "unreachable";
  sourceUrl: string;
  fetchedAt: string;
  window: StateWindow | null;
  quote: Quote | null;
  note: string | null;
};

export async function buildState(args: {
  feed: PriceFeed;
  at: Date;
  kwhMilli: bigint;
  mintDecimals: number;
}): Promise<TerminalState> {
  const sourceUrl = feedUrlFor(args.at);
  const fetchedAt = args.at.toISOString();

  let window: StateWindow | null = null;
  try {
    window = await args.feed.getWindow(args.at);
  } catch {
    window = null;
  }
  if (window === null) {
    return {
      feed: "unreachable",
      sourceUrl,
      fetchedAt,
      window: null,
      quote: null,
      note: "The price feed could not be reached, so there is no price and no quote.",
    };
  }

  const quote = quoteForWindow({
    window,
    kwhMilli: args.kwhMilli,
    mintDecimals: args.mintDecimals,
  });
  return {
    feed: "ok",
    sourceUrl,
    fetchedAt,
    window,
    quote,
    note:
      quote === null
        ? "The fetched price is zero or negative, so no charge is quoted for this window."
        : null,
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
          state.feed === "ok"
            ? "no chargeable quote for this window"
            : "price feed unreachable, no quote offered",
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
