// Issue 156. A listed successful transaction that invokes the program and
// comes back with logMessages null was not checked. An empty log list is not
// the same thing: null means the body did not include the logs.
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OUTER = "ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o";
const AGENT = "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w";

function listed(signature: string) {
  return {
    signature,
    slot: 3,
    err: null,
    memo: null,
    blockTime: 1_790_200_100,
    confirmationStatus: "confirmed" as const,
  };
}

function tx(args: {
  topProgram: number;
  innerProgram: number | null;
  logs: string[] | null;
}) {
  return {
    slot: 3,
    blockTime: 1_790_200_100,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, PROGRAM, OUTER],
        compiledInstructions: [
          { programIdIndex: args.topProgram, accountKeyIndexes: [0, 1], data: Buffer.from([1]) },
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions:
        args.innerProgram === null
          ? []
          : [{ index: 0, instructions: [{ programIdIndex: args.innerProgram, accounts: [0], data: "" }] }],
      logMessages: args.logs,
    },
  };
}

function connection(body: unknown): Connection {
  return {
    async getSignaturesForAddress() {
      return [listed("sig-null")];
    },
    async getTransaction() {
      return body;
    },
  } as unknown as Connection;
}

async function history(body: unknown) {
  return fetchDecisionHistory({
    rpcUrl: "http://127.0.0.1:1",
    programId: PROGRAM,
    connection: connection(body),
    allowBlockScan: false,
  });
}

test("a listed CPI that invokes the program with a null log body is not checked", async () => {
  // Top-level program is the relay. The inner instruction invokes this program.
  const body = tx({ topProgram: 2, innerProgram: 1, logs: null });
  await assert.rejects(
    () => history(body),
    (err: unknown) => {
      assert.equal(isTransportError(err), true);
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /sig-null/);
      assert.match(message, /null log body/);
      assert.match(message, /invokes the program/);
      return true;
    },
  );
});

test("a listed top-level invoke with a null log body is not checked", async () => {
  const body = tx({ topProgram: 1, innerProgram: null, logs: null });
  await assert.rejects(
    () => history(body),
    (err: unknown) => {
      assert.equal(isTransportError(err), true);
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /sig-null/);
      assert.match(message, /null log body/);
      return true;
    },
  );
});

test("a listed CPI with an empty log array is absent, not a null log body", async () => {
  const result = await history(tx({ topProgram: 2, innerProgram: 1, logs: [] }));
  assert.deepEqual(result.decisions, []);
});

test("a listed transaction that does not invoke the program stays absent when the log body is null", async () => {
  const result = await history(tx({ topProgram: 2, innerProgram: null, logs: null }));
  assert.deepEqual(result.decisions, []);
});

test("a failed transaction with a null log body stays out", async () => {
  const body = tx({ topProgram: 1, innerProgram: null, logs: null });
  body.meta.err = { InstructionError: [0, "Custom"] };
  const result = await history(body);
  assert.deepEqual(result.decisions, []);
});

test("a block scan that finds a CPI with a null log body is not checked", async () => {
  const body = tx({ topProgram: 2, innerProgram: 1, logs: null });
  const conn = {
    async getSignaturesForAddress() {
      return [];
    },
    async getSlot() {
      return 5;
    },
    async getFirstAvailableBlock() {
      return 5;
    },
    async getBlocks() {
      return [5];
    },
    async getBlock() {
      return {
        blockTime: 1_790_200_100,
        transactions: [
          {
            transaction: {
              signatures: ["sig-block"],
              message: body.transaction.message,
            },
            meta: body.meta,
          },
        ],
      };
    },
  } as unknown as Connection;
  await assert.rejects(
    () =>
      fetchDecisionHistory({
        rpcUrl: "http://127.0.0.1:1",
        programId: PROGRAM,
        connection: conn,
        allowBlockScan: true,
        maxSlots: 1,
      }),
    (err: unknown) => {
      assert.equal(isTransportError(err), true);
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /sig-block/);
      assert.match(message, /null log body/);
      return true;
    },
  );
});
