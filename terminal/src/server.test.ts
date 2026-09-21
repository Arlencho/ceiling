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

// Round 2 critic fixtures. F2: the error lands on stderr, where the operator
// running `node src/index.ts serve` is looking, while the wire carries only
// the generic body. Issue 73: the boundary still turns over when the day file
// has skipped entries around it, since the parser changed underneath it.

test("round 2: the operator sees the error on stderr and the caller sees only the generic body", async () => {
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
  const stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const rows: Array<{ path: string; body: string; type: RegExp }> = [
      { path: "/api/quote", body: '{"error":"internal error"}', type: /application\/json/ },
      { path: "/api/state", body: '{"error":"internal error"}', type: /application\/json/ },
      { path: "/", body: "terminal error", type: /text\/plain/ },
    ];
    for (const row of rows) {
      stderr.length = 0;
      const res = await fetch(`${base}${row.path}`, { signal: AbortSignal.timeout(5_000) });
      const text = await res.text();
      assert.equal(res.status, 500, row.path);
      assert.match(res.headers.get("content-type") ?? "", row.type, row.path);
      assert.equal(text, row.body, row.path);
      const headerDump = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      assert.ok(!headerDump.includes(secret), `${row.path}: headers`);
      const logged = stderr.join("");
      assert.ok(logged.includes(secret), `${row.path}: the message reaches stderr`);
      assert.ok(logged.includes("at "), `${row.path}: the stack reaches stderr, not a flattened string`);
    }
  } finally {
    process.stderr.write = realWrite;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

async function listenCountingBody(body: string): Promise<{
  base: string;
  fetches: () => number;
  close: () => Promise<void>;
}> {
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

test("round 2: the boundary turns over on a day file with skipped entries around both windows", async () => {
  // Decoys: a priced entry with no end, a null-priced entry claiming window B's
  // slot before B does, and a nested copy of the key after B. None may leak.
  const body = `[${entry("0.11111", START_A, END_A)},{"SEK_per_kWh":0.99999,"time_start":"${END_A}"},{"SEK_per_kWh":null,"time_start":"${END_A}","time_end":"${END_B}"},${entry("0.22222", END_A, END_B)},{"meta":{"SEK_per_kWh":0.99999},"time_start":"${END_B}","time_end":"2026-09-20T10:45:00+02:00"}]`;
  const { base, fetches, close } = await listenCountingBody(body);
  const boundary = Date.parse(END_A);
  try {
    const first = await quoteAt(base, boundary - 14_000);
    const second = await quoteAt(base, boundary - 1);
    assert.equal(fetches(), 1, "inside the window the cache still serves");
    assert.equal(first.nonce, second.nonce);
    assert.equal(second.window_start, START_A);
    assert.equal(second.sek_per_kwh, "0.11111");
    assert.equal(second.amount, "5555500");
    const after = await quoteAt(base, boundary);
    assert.equal(after.window_start, END_A);
    assert.equal(after.window_end, END_B);
    assert.equal(after.sek_per_kwh, "0.22222");
    assert.equal(after.amount, "11111000");
    assert.equal(after.nonce, (BigInt(boundary) / 1000n).toString());
    assert.notEqual(after.nonce, second.nonce);
    assert.equal(fetches(), 2, "the boundary forces a rebuild even inside the TTL");
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
    // After B ends, the nested-only entry owns the slot and must not price it.
    const realNow2 = Date.now;
    Date.now = () => Date.parse(END_B) + 1_000;
    try {
      const res = await fetch(`${base}/api/quote`);
      const text = await res.text();
      assert.equal(res.status, 503, "the slot after B has no readable price");
      assert.ok(!text.includes("0.99999"), "the decoy price never reaches the wire");
    } finally {
      Date.now = realNow2;
    }
  } finally {
    await close();
  }
});
