/** HTTP server: the screen, plus the JSON the agent reads.
 *
 * GET /           the terminal page (reloads itself every 5 seconds)
 * GET /api/quote  amount and nonce for the current window, or 503 with no price
 * GET /api/state  the same view model the page renders, as JSON
 */

import { createServer, type Server } from "node:http";
import { Connection } from "@solana/web3.js";
import { EnergySpotFeed, type PriceFeed } from "../../watcher/src/feed.js";
import type { TerminalConfig } from "./config.js";
import { fetchBalance, fetchPayments, type Payment } from "./payments.js";
import { renderPage, type PageView } from "./page.js";
import { formatBaseUnits, formatKwh } from "./quote.js";
import { buildState, quoteResponse, type TerminalState } from "./state.js";

const STATE_TTL_MS = 20_000;
const PAYMENTS_TTL_MS = 15_000;

export type TerminalDeps = {
  cfg: TerminalConfig;
  feed?: PriceFeed;
  connection?: Connection;
};

type PaymentsSnapshot = {
  fetchedMs: number;
  payments: Payment[];
  balance: bigint | null;
  error: string | null;
  okAt: string | null;
};

export function viewFromState(state: TerminalState, snap: PaymentsSnapshot, cfg: TerminalConfig): PageView {
  return {
    generatedAt: state.fetchedAt,
    sourceUrl: state.sourceUrl,
    feed: state.feed,
    httpStatus: state.httpStatus,
    windowStart: state.window?.timeStart ?? null,
    windowEnd: state.window?.timeEnd ?? null,
    sekPerKwh: state.window?.sekPerKwh ?? null,
    kwh: formatKwh(cfg.kwhMilli),
    amountTokens: state.quote === null ? null : formatBaseUnits(state.quote.amount, cfg.mintDecimals),
    amountBaseUnits: state.quote === null ? null : state.quote.amount.toString(),
    nonce: state.quote === null ? null : state.quote.nonce.toString(),
    note: state.note,
    merchantTokenAccount: cfg.merchantTokenAccount,
    mint: cfg.mint,
    programId: cfg.programId,
    explorerQuery: cfg.explorerQuery,
    balanceTokens: snap.balance === null ? null : formatBaseUnits(snap.balance, cfg.mintDecimals),
    payments: snap.payments.map((p) => ({
      time: p.blockTime ?? "unknown",
      amountTokens: formatBaseUnits(p.amount, cfg.mintDecimals),
      signature: p.signature,
    })),
    paymentsError: snap.error,
    paymentsAt: snap.okAt,
    refreshFailed: state.refreshFailed,
  };
}

export function createTerminalServer(deps: TerminalDeps): Server {
  const cfg = deps.cfg;
  const feed = deps.feed ?? new EnergySpotFeed();
  const connection = deps.connection ?? new Connection(cfg.rpc, "confirmed");

  let stateCache: { fetchedMs: number; state: TerminalState } | null = null;
  let paymentsCache: PaymentsSnapshot | null = null;

  function cacheValidUntil(fetchedMs: number, windowEnd: string | null | undefined): number {
    const ttlEnd = fetchedMs + STATE_TTL_MS;
    if (windowEnd === undefined || windowEnd === null) return ttlEnd;
    const boundary = Date.parse(windowEnd);
    if (!Number.isFinite(boundary)) return ttlEnd;
    return Math.min(ttlEnd, boundary);
  }

  async function currentState(): Promise<TerminalState> {
    const nowMs = Date.now();
    if (
      stateCache !== null &&
      nowMs < cacheValidUntil(stateCache.fetchedMs, stateCache.state.window?.timeEnd)
    ) {
      return stateCache.state;
    }
    const state = await buildState({
      feed,
      at: new Date(nowMs),
      kwhMilli: cfg.kwhMilli,
      mintDecimals: cfg.mintDecimals,
    });
    stateCache = { fetchedMs: nowMs, state };
    return state;
  }

  async function currentPayments(): Promise<PaymentsSnapshot> {
    const nowMs = Date.now();
    if (paymentsCache !== null && nowMs - paymentsCache.fetchedMs < PAYMENTS_TTL_MS) {
      return paymentsCache;
    }
    try {
      const [balance, payments] = await Promise.all([
        fetchBalance({ connection, tokenAccount: cfg.merchantTokenAccount }),
        fetchPayments({ connection, tokenAccount: cfg.merchantTokenAccount }),
      ]);
      paymentsCache = {
        fetchedMs: nowMs,
        payments,
        balance,
        error: null,
        okAt: new Date(nowMs).toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      paymentsCache = {
        fetchedMs: nowMs,
        payments: paymentsCache?.payments ?? [],
        balance: paymentsCache?.balance ?? null,
        error: `RPC unreachable: ${message}`,
        okAt: paymentsCache?.okAt ?? null,
      };
    }
    return paymentsCache;
  }

  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const jsonApi = path === "/api/quote" || path === "/api/state";
    void (async () => {
      if (req.method === "GET" && path === "/api/quote") {
        const state = await currentState();
        const { status, body } = quoteResponse(state, cfg);
        const payload = JSON.stringify(body, null, 2);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        const [state, snap] = await Promise.all([currentState(), currentPayments()]);
        const payload = JSON.stringify(viewFromState(state, snap, cfg), null, 2);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
        return;
      }
      if (req.method === "GET" && path === "/") {
        const [state, snap] = await Promise.all([currentState(), currentPayments()]);
        const html = renderPage(viewFromState(state, snap, cfg));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    })().catch(() => {
      if (res.headersSent) return;
      if (jsonApi) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("terminal error");
    });
  });
}
