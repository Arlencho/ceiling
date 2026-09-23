import assert from "node:assert/strict";
import test from "node:test";
import {
  RateLimitedError,
  TransportError,
  isRateLimitError,
  isRetryable,
  isSkippableSlot,
  makeFailoverFetch,
  paginateNewestFirst,
  parseRpcList,
  withRetry,
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

test("a malformed rpc entry names its position and does not echo the value", () => {
  const secret = "rpc.example.test/?api-key=SECRET123";
  assert.throws(
    () => parseRpcList(secret),
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
      assert.equal(message.includes("rpc.example.test"), false, message);
      assert.match(message, /position 2/);
      return true;
    },
  );
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

test("a non-2xx transport error keeps at most 300 bytes of the response body", async () => {
  const body = "x".repeat(500);
  const failover = makeFailoverFetch(["http://primary.invalid"], () => {}, {
    fetch: async () => new Response(body, { status: 502, statusText: "Bad Gateway" }),
    sleep: async () => {},
    initialDelayMs: 0,
  });
  await assert.rejects(
    () => failover("http://primary.invalid", { method: "POST" }),
    (err: unknown) => {
      assert.ok(err instanceof TransportError);
      const carried = err.message.slice("502 Bad Gateway: ".length);
      assert.equal(Buffer.byteLength(carried), 300);
      assert.equal(carried, "x".repeat(300));
      return true;
    },
  );
});

test("a 200 body that is not a JSON-RPC envelope is a transport error", async () => {
  const failover = makeFailoverFetch(["http://primary.invalid"], () => {}, {
    fetch: async () => new Response("{}", { status: 200, statusText: "OK" }),
    sleep: async () => {},
    initialDelayMs: 0,
  });
  await assert.rejects(
    () => failover("http://primary.invalid", { method: "POST" }),
    (err: unknown) => err instanceof TransportError,
  );
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
