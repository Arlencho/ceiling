import assert from "node:assert/strict";
import test from "node:test";
import {
  RateLimitedError,
  isRateLimitError,
  isRetryable,
  isSkippableSlot,
  makeFailoverFetch,
  paginateNewestFirst,
  parseRpcList,
  withRetry,
  withRpcFailover,
} from "./rpc.js";

test("paginates getSignaturesForAddress past one page using the before cursor", async () => {
  const pages: Record<string, { signature: string }[]> = {
    "": [{ signature: "sig5" }, { signature: "sig4" }],
    sig4: [{ signature: "sig3" }, { signature: "sig2" }],
    sig2: [{ signature: "sig1" }],
  };
  const befores: (string | undefined)[] = [];
  const result = await paginateNewestFirst(async (before) => {
    befores.push(before);
    return pages[before ?? ""] ?? [];
  }, 2);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(
    result.items.map((i) => i.signature),
    ["sig5", "sig4", "sig3", "sig2", "sig1"],
  );
  assert.deepEqual(befores, [undefined, "sig4", "sig2"]);
});

test("a short final page stops pagination", async () => {
  const result = await paginateNewestFirst(async () => [{ signature: "only" }], 10);
  assert.equal(result.pageCount, 1);
  assert.equal(result.items.length, 1);
});

test("retries retryable RPC hiccups and then succeeds", async () => {
  let n = 0;
  const value = await withRetry(
    "probe",
    async () => {
      n += 1;
      if (n < 3) throw new Error("429 Too many requests");
      return "ok";
    },
    { attempts: 5, baseDelayMs: 1, log: () => {} },
  );
  assert.equal(value, "ok");
  assert.equal(n, 3);
});

test("parseRpcList keeps order and splits a comma-separated VETO_RPC list", () => {
  assert.deepEqual(parseRpcList("http://dedicated.invalid, http://127.0.0.1:8999"), [
    "http://dedicated.invalid",
    "http://127.0.0.1:8999",
  ]);
});

test("a 429 is retried on the next endpoint rather than treated as a dead read", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("primary")) {
      return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const lines: string[] = [];
  const failover = makeFailoverFetch(
    ["http://primary.invalid", "http://fallback.invalid"],
    (line) => lines.push(line),
    { fetch: fetchImpl, sleep: async () => {}, initialDelayMs: 0 },
  );
  const res = await failover("http://primary.invalid", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["http://primary.invalid", "http://fallback.invalid"]);
  assert.match(lines.join("\n"), /rate limited/);
  assert.doesNotMatch(lines.join("\n"), /failure/);
});

test("withRpcFailover walks the list on 429 and then succeeds", async () => {
  const seen: string[] = [];
  const lines: string[] = [];
  const value = await withRpcFailover(
    "getAccountInfo",
    ["http://primary.invalid", "http://fallback.invalid"],
    async (endpoint) => {
      seen.push(endpoint);
      if (endpoint.includes("primary")) throw new Error("429 Too Many Requests");
      return "ok";
    },
    { log: (line) => lines.push(line), sleep: async () => {}, initialDelayMs: 0 },
  );
  assert.equal(value, "ok");
  assert.deepEqual(seen, ["http://primary.invalid", "http://fallback.invalid"]);
  assert.match(lines.join("\n"), /rate limited/);
  assert.doesNotMatch(lines.join("\n"), /failure/);
});

test("withRetry logs a 429 as a rate limit, not a failure", async () => {
  const lines: string[] = [];
  let n = 0;
  const value = await withRetry(
    "probe",
    async () => {
      n += 1;
      if (n < 2) throw new Error("429 Too many requests");
      return "ok";
    },
    { attempts: 5, baseDelayMs: 1, log: (line) => lines.push(line) },
  );
  assert.equal(value, "ok");
  assert.equal(n, 2);
  assert.match(lines.join("\n"), /rate limited/);
  assert.doesNotMatch(lines.join("\n"), /failure/);
  assert.equal(isRateLimitError(new RateLimitedError("rpc rate limited on http://a")), true);
});

test("does not retry a cleaned-up slot", async () => {
  await assert.rejects(
    () =>
      withRetry("getBlock", async () => {
        throw new Error("Block 4 cleaned up, does not exist on node");
      }),
    /cleaned up/,
  );
  assert.equal(isRetryable(new Error("Block 4 cleaned up, does not exist on node")), false);
  assert.equal(isSkippableSlot(new Error("Block not available for slot 12")), true);
});
