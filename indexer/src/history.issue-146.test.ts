// Issue 146. A signature the same RPC just listed, then answered null for,
// was not checked. A failed signature (page.err) stays out.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";

function listed(signature: string, err: unknown = null) {
  return {
    signature,
    slot: 1,
    err,
    memo: null,
    blockTime: 1_790_200_000,
    confirmationStatus: "confirmed" as const,
  };
}

test("a listed signature whose getTransaction answers null is not checked", async () => {
  const conn = {
    async getSignaturesForAddress() {
      return [listed("sig-dropped")];
    },
    async getTransaction() {
      return null;
    },
  } as unknown as Connection;
  await assert.rejects(
    () =>
      fetchDecisionHistory({
        rpcUrl: "http://127.0.0.1:1",
        programId: PROGRAM,
        connection: conn,
        allowBlockScan: false,
      }),
    (err: unknown) => {
      assert.equal(isTransportError(err), true);
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /sig-dropped/);
      assert.match(message, /no transaction for a listed signature/);
      return true;
    },
  );
});

test("a listed signature the RPC marks failed stays out and is not a transport error", async () => {
  let fetches = 0;
  const conn = {
    async getSignaturesForAddress() {
      return [listed("sig-failed", { InstructionError: [0, "Custom"] })];
    },
    async getTransaction() {
      fetches += 1;
      return null;
    },
  } as unknown as Connection;
  const history = await fetchDecisionHistory({
    rpcUrl: "http://127.0.0.1:1",
    programId: PROGRAM,
    connection: conn,
    allowBlockScan: false,
  });
  assert.equal(fetches, 0);
  assert.deepEqual(history.decisions, []);
  assert.equal(new PublicKey(PROGRAM).toBase58(), PROGRAM);
});
