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
