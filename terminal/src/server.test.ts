import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { EnergySpotFeed } from "../../watcher/src/feed.js";
import type { TerminalConfig } from "./config.js";
import { createTerminalServer } from "./server.js";

const CFG: TerminalConfig = {
  rpc: "http://rpc.invalid",
  programId: "Prog",
  mint: "Mint",
  merchant: "Merchant",
  merchantTokenAccount: "MerchantTokenAcct",
  kwhMilli: 50_000n,
  mintDecimals: 6,
  port: 0,
  explorerQuery: "",
};

const rpcOff = {
  getTokenAccountBalance: async () => {
    throw new Error("rpc off");
  },
  getSignaturesForAddress: async () => {
    throw new Error("rpc off");
  },
} as unknown as Connection;

function entry(sek: string, start: string, end: string): string {
  return `{"SEK_per_kWh":${sek},"EUR_per_kWh":1e-05,"EXR":11.17,"time_start":"${start}","time_end":"${end}"}`;
}

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const startA = "2026-09-20T10:00:00+02:00";
  const endA = "2026-09-20T10:15:00+02:00";
  const startB = "2026-09-20T10:15:00+02:00";
  const endB = "2026-09-20T10:30:00+02:00";
  const body = `[${entry("0.11111", startA, endA)},${entry("0.22222", startB, endB)}]`;
  const feed = new EnergySpotFeed(async () => new Response(body, { status: 200 }));
  const server = createTerminalServer({ cfg: CFG, feed, connection: rpcOff });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  return {
    base: `http://127.0.0.1:${String(addr.port)}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("a cached quote does not outlive the window it is an offer for", async () => {
  const { base, close } = await listen();
  const boundary = Date.parse("2026-09-20T10:15:00+02:00");
  const before = boundary - 10_000;
  const after = boundary + 5_000;
  const realNow = Date.now;
  Date.now = () => before;
  try {
    const firstRes = await fetch(`${base}/api/quote`);
    const first = (await firstRes.json()) as Record<string, unknown>;
    assert.equal(firstRes.status, 200);
    assert.equal(first.window_start, "2026-09-20T10:00:00+02:00");
    Date.now = () => after;
    const secondRes = await fetch(`${base}/api/quote`);
    const second = (await secondRes.json()) as Record<string, unknown>;
    assert.equal(secondRes.status, 200);
    assert.equal(second.window_start, "2026-09-20T10:15:00+02:00");
    assert.equal(second.sek_per_kwh, "0.22222");
    assert.notEqual(first.nonce, second.nonce);
  } finally {
    Date.now = realNow;
    await close();
  }
});

test("JSON endpoints answer a JSON 500 and leak no internal message", async () => {
  const secret = "secret-internal-token-do-not-leak";
  const cfg: TerminalConfig = { ...CFG };
  Object.defineProperty(cfg, "mint", {
    get: () => {
      throw new Error(secret);
    },
    enumerable: true,
  });
  const window = {
    timeStart: "2026-09-20T10:00:00+02:00",
    timeEnd: "2026-09-20T10:15:00+02:00",
    sekPerKwh: "0.11111",
  };
  const feed = {
    getWindow: async () => window,
    readWindow: async () => ({
      status: "ok" as const,
      sourceUrl: "http://example.invalid/day.json",
      readAt: new Date("2026-09-20T10:05:00+02:00"),
      refreshFailed: false,
      window,
      httpStatus: null,
    }),
  };
  const server = createTerminalServer({ cfg, feed, connection: rpcOff });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  const base = `http://127.0.0.1:${String(addr.port)}`;
  try {
    for (const path of ["/api/quote", "/api/state"]) {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
      const text = await res.text();
      assert.equal(res.status, 500, path);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, path);
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(typeof body.error, "string", path);
      assert.ok(!text.includes(secret), path);
      assert.ok(!text.includes("terminal error:"), path);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// Round 1 critic fixtures for #73 and #74.

const START_A = "2026-09-20T10:00:00+02:00";
const END_A = "2026-09-20T10:15:00+02:00";
const END_B = "2026-09-20T10:30:00+02:00";

async function listenCounting(): Promise<{
  base: string;
  fetches: () => number;
  close: () => Promise<void>;
}> {
  const body = `[${entry("0.11111", START_A, END_A)},${entry("0.22222", END_A, END_B)}]`;
  let fetches = 0;
  const feed = new EnergySpotFeed(async () => {
    fetches += 1;
    return new Response(body, { status: 200 });
  });
  const server = createTerminalServer({ cfg: CFG, feed, connection: rpcOff });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  return {
    base: `http://127.0.0.1:${String(addr.port)}`,
    fetches: () => fetches,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function quoteAt(base: string, nowMs: number): Promise<Record<string, unknown>> {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    const res = await fetch(`${base}/api/quote`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    Date.now = realNow;
  }
}

test("inside one window the quote is still served from cache", async () => {
  const { base, fetches, close } = await listenCounting();
  const boundary = Date.parse(END_A);
  try {
    const first = await quoteAt(base, boundary - 14_000);
    const second = await quoteAt(base, boundary - 9_000);
    const third = await quoteAt(base, boundary - 1);
    assert.equal(fetches(), 1, "three requests inside the window and the TTL hit the feed once");
    assert.deepEqual([first.nonce, second.nonce, third.nonce], [first.nonce, first.nonce, first.nonce]);
  } finally {
    await close();
  }
});

test("the first request after a boundary carries neither the old nonce nor the old amount", async () => {
  const { base, fetches, close } = await listenCounting();
  const boundary = Date.parse(END_A);
  try {
    const before = await quoteAt(base, boundary - 1);
    const after = await quoteAt(base, boundary);
    assert.equal(before.window_start, START_A);
    assert.equal(after.window_start, END_A);
    assert.equal(before.amount, "5555500");
    assert.equal(after.amount, "11111000");
    assert.equal(before.nonce, (BigInt(Date.parse(START_A)) / 1000n).toString());
    assert.equal(after.nonce, (BigInt(boundary) / 1000n).toString());
    assert.equal(fetches(), 2, "the boundary forces a rebuild even inside the TTL");
    // /api/state is fed by the same cache and must agree with the quote.
    const realNow = Date.now;
    Date.now = () => boundary + 1_000;
    try {
      const stateRes = await fetch(`${base}/api/state`);
      const view = (await stateRes.json()) as Record<string, unknown>;
      assert.equal(view.nonce, after.nonce);
      assert.equal(view.amountBaseUnits, after.amount);
    } finally {
      Date.now = realNow;
    }
  } finally {
    await close();
  }
});

test("an internal error on a JSON endpoint is logged on the server, not dropped", async () => {
  const secret = "secret-internal-token-do-not-leak";
  const cfg: TerminalConfig = { ...CFG };
  Object.defineProperty(cfg, "mint", {
    get: () => {
      throw new Error(secret);
    },
    enumerable: true,
  });
  const window = { timeStart: START_A, timeEnd: END_A, sekPerKwh: "0.11111" };
  const feed = {
    getWindow: async () => window,
    readWindow: async () => ({
      status: "ok" as const,
      sourceUrl: "http://example.invalid/day.json",
      readAt: new Date("2026-09-20T10:05:00+02:00"),
      refreshFailed: false,
      window,
      httpStatus: null,
    }),
  };
  const server = createTerminalServer({ cfg, feed, connection: rpcOff });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  const base = `http://127.0.0.1:${String(addr.port)}`;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  try {
    for (const path of ["/api/quote", "/api/state"]) {
      logged.length = 0;
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
      const text = await res.text();
      assert.equal(res.status, 500, path);
      assert.ok(!text.includes(secret), path);
      assert.ok(
        logged.some((line) => line.includes(secret)),
        `${path}: the operator must see the error the client was spared`,
      );
    }
  } finally {
    console.error = realError;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
