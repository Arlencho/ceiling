// Issue 149. withRetry keeps a JSON-RPC error typed. -32602 stays a parameter
// failure. Every other JSON-RPC code is transport.
import assert from "node:assert/strict";
import test from "node:test";
import { SolanaJSONRPCError } from "@solana/web3.js";
import { isTransportError, withRetry } from "./rpc.js";

test("withRetry keeps JSON-RPC -32005 typed as transport", async () => {
  await assert.rejects(
    () =>
      withRetry(
        "getSignaturesForAddress",
        async () => {
          throw new SolanaJSONRPCError({ code: -32005, message: "Node is unhealthy" }, "failed");
        },
        { attempts: 1, baseDelayMs: 0 },
      ),
    (err: unknown) => {
      assert.equal(isTransportError(err), true);
      return true;
    },
  );
});

test("withRetry keeps JSON-RPC -32602 as a parameter failure", async () => {
  await assert.rejects(
    () =>
      withRetry(
        "getTransaction",
        async () => {
          throw new SolanaJSONRPCError({ code: -32602, message: "Invalid param: WrongSize" }, "failed");
        },
        { attempts: 1, baseDelayMs: 0 },
      ),
    (err: unknown) => {
      assert.equal(isTransportError(err), false);
      const code = typeof err === "object" && err !== null && "code" in err ? (err as { code: unknown }).code : null;
      assert.equal(code, -32602);
      return true;
    },
  );
});
