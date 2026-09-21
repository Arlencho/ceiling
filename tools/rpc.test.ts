import assert from "node:assert/strict";
import test from "node:test";
import {
  RateLimitedError,
  isRateLimitError,
  makeFailoverFetch,
  parseRpcList,
} from "../indexer/src/rpc.js";

test("parseRpcList keeps order and splits a comma-separated list", () => {
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

test("isRateLimitError still matches a 429 status line", () => {
  assert.equal(isRateLimitError(new Error("429 Too Many Requests")), true);
  assert.equal(isRateLimitError(new RateLimitedError("rpc rate limited on http://a")), true);
});
