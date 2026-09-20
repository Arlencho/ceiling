import assert from "node:assert/strict";
import test from "node:test";
import { isRetryable, isSkippableSlot, paginateNewestFirst, withRetry } from "./rpc.js";

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
    { attempts: 5, baseDelayMs: 1 },
  );
  assert.equal(value, "ok");
  assert.equal(n, 3);
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
