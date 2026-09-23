import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import {
  RateLimitedError,
  isRateLimitError,
  makeFailoverFetch,
  parseRpcList,
} from "./rpc.js";

// Every chain identity is required now: the loader stopped inventing an
// endpoint, a program or an account when nothing is configured. These tests
// were written while those defaults still existed, so they name them here.
// Nothing about what they assert has changed.
const IDENTITIES = {
  VETO_PROGRAM_ID: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  VETO_MINT: "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU",
  VETO_OWNER: "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc",
  VETO_OWNER_TOKEN: "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE",
  VETO_MERCHANT: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  VETO_MERCHANT_TOKEN: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  VETO_AGENT: "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w",
};

test("parseRpcList keeps order, splits on commas and whitespace, and drops duplicates", () => {
  assert.deepEqual(parseRpcList("http://a.invalid"), ["http://a.invalid"]);
  assert.deepEqual(parseRpcList("http://a.invalid, http://b.invalid"), [
    "http://a.invalid",
    "http://b.invalid",
  ]);
  assert.deepEqual(parseRpcList("http://a.invalid\nhttp://b.invalid"), [
    "http://a.invalid",
    "http://b.invalid",
  ]);
  assert.deepEqual(parseRpcList("http://a.invalid, http://a.invalid, http://b.invalid"), [
    "http://a.invalid",
    "http://b.invalid",
  ]);
  assert.deepEqual(parseRpcList("  ,  "), []);
});

test("loadConfig honours a comma-separated VETO_RPC list, first URL first", () => {
  const cfg = loadConfig({
    ...IDENTITIES,
    VETO_RPC: "http://dedicated.invalid, http://127.0.0.1:8999",
    VETO_KEYS_DIR: "/tmp/veto-rpc-test-keys-missing",
  });
  assert.deepEqual(cfg.rpcs, ["http://dedicated.invalid", "http://127.0.0.1:8999"]);
  assert.equal(cfg.rpc, "http://dedicated.invalid");
});

test("isRateLimitError is true for 429 and rate-limit wording, false for a dead read", () => {
  assert.equal(isRateLimitError(new Error("429 Too Many Requests")), true);
  assert.equal(isRateLimitError(new Error("Server responded with 429")), true);
  assert.equal(isRateLimitError(new RateLimitedError("rpc rate limited on http://a")), true);
  assert.equal(isRateLimitError(new Error("fetch failed")), false);
  assert.equal(isRateLimitError(new Error("Block 4 cleaned up, does not exist on node")), false);
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
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /rate limited/);
  assert.doesNotMatch(lines.join("\n"), /failure/);
});

test("when every endpoint rate limits, the error names the rate limit", async () => {
  const lines: string[] = [];
  const failover = makeFailoverFetch(
    ["http://a.invalid", "http://b.invalid"],
    (line) => lines.push(line),
    {
      fetch: async () => new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" }),
      sleep: async () => {},
      initialDelayMs: 0,
      maxPasses: 1,
    },
  );
  await assert.rejects(
    () => failover("http://a.invalid", { method: "POST" }),
    (err: unknown) => {
      assert.equal(err instanceof RateLimitedError, true);
      assert.match(err instanceof Error ? err.message : "", /rate limited/);
      return true;
    },
  );
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /rate limited/);
    assert.doesNotMatch(line, /failure/);
  }
});

// Critic fixtures, round 1. Each one goes RED on b23b9d3.

test("critic: one configured endpoint still backs off on a transient 429 instead of surfacing it on the first throttle", async () => {
  // Before this branch, web3.js retried a 429 on the same endpoint four more
  // times (500 ms doubling). disableRetryOnRateLimit: true removed that and
  // makeFailoverFetch only moves between entries, so the default one-URL
  // config now gets zero retries on a rate limit.
  let n = 0;
  const slept: number[] = [];
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) {
      return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), { status: 200 });
  };
  const failover = makeFailoverFetch(["http://only.invalid"], () => {}, {
    fetch: fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    initialDelayMs: 1,
  });
  const res = await failover("http://only.invalid", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(n, 2);
  assert.ok(slept.length >= 1, "a bounded backoff must run before the retry");
});

test("critic: a malformed entry in VETO_RPC is refused at load, not discovered at the first 429", () => {
  assert.throws(() =>
    loadConfig({
      VETO_RPC: "http://a.invalid, gargabe",
      VETO_KEYS_DIR: "/tmp/veto-rpc-test-keys-missing",
    }),
  );
});

test("a malformed VETO_RPC entry names its position and does not echo the value", () => {
  const secret = "rpc.example.test/?api-key=SECRET123";
  assert.throws(
    () =>
      loadConfig({
        ...IDENTITIES,
        VETO_RPC: secret,
        VETO_KEYS_DIR: "/tmp/veto-rpc-test-keys-missing",
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message.includes("SECRET123"), false, message);
      assert.equal(message.includes("rpc.example.test"), false, message);
      assert.match(message, /position 1/);
      return true;
    },
  );
  assert.throws(
    () => parseRpcList(`http://ok.example, ws://rpc.example.test/?api-key=SECRET123`),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message.includes("SECRET123"), false, message);
      assert.match(message, /position 2/);
      return true;
    },
  );
});

test("critic: an unconfirmed-transaction timeout is not a rate limit even when the signature contains 429", () => {
  // web3.js TransactionExpiredTimeoutError message shape. Base58 signatures
  // can contain the digits 429. This is the one error where the send may
  // have landed, and classifying it as a rate limit routes it to deferred
  // and a resubmit of the same nonce.
  const msg =
    "Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. Check signature 3Q429kLmNoPqRsTuVwXyZ using the Solana Explorer or CLI tools.";
  assert.equal(isRateLimitError(new Error(msg)), false);
});
