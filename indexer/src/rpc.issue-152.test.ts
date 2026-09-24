// Issue 152. res.statusText is capped the same way as the response body.
import assert from "node:assert/strict";
import test from "node:test";
import { TransportError, makeFailoverFetch } from "./rpc.js";

test("a long statusText is capped at 300 bytes", async () => {
  const statusText = "S".repeat(400);
  const failover = makeFailoverFetch(["http://primary.invalid"], () => {}, {
    fetch: async () => new Response("nope", { status: 502, statusText }),
    sleep: async () => {},
    initialDelayMs: 0,
  });
  await assert.rejects(
    () => failover("http://primary.invalid", { method: "POST" }),
    (err: unknown) => {
      assert.ok(err instanceof TransportError);
      const message = err.message;
      assert.ok(!message.includes("S".repeat(301)), message);
      const carried = message.slice("502 ".length).split(":")[0] ?? "";
      assert.ok(Buffer.byteLength(carried) <= 300, `statusText carried ${Buffer.byteLength(carried)} bytes`);
      return true;
    },
  );
});
