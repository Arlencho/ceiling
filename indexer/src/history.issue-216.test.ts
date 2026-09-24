// Issue 216. A version 0 transaction can name the program only through an
// address lookup table. When loadedAddresses is absent beside a missing log
// body, the invokes-the-program test cannot be answered. The transaction is
// not checked. It is never treated as absent.
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OUTER = "ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o";
const AGENT = "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w";
const TABLE = "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc";

// Top level invokes the relay. The inner program id index points at the
// lookup table slot, which is not among the static keys, and the node did
// not return loadedAddresses.
function message() {
  return {
    staticAccountKeys: [AGENT, OUTER],
    compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
    addressTableLookups: [{ accountKey: TABLE, writableIndexes: [], readonlyIndexes: [0] }],
  };
}

function meta() {
  return {
    err: null,
    logMessages: null,
    innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0], data: "" }] }],
  };
}

function unchecked(signature: string) {
  return (err: unknown) => {
    assert.equal(isTransportError(err), true);
    const text = err instanceof Error ? err.message : String(err);
    assert.match(text, new RegExp(signature));
    assert.match(text, /null log body/);
    assert.match(text, /invokes the program/);
    return true;
  };
}

test("a listed version 0 transaction with loadedAddresses absent beside a missing log body is not checked", async () => {
  const connection = {
    async getSignaturesForAddress() {
      return [
        {
          signature: "sig-alt",
          slot: 3,
          err: null,
          memo: null,
          blockTime: 1_790_200_100,
          confirmationStatus: "confirmed" as const,
        },
      ];
    },
    async getTransaction() {
      return { slot: 3, blockTime: 1_790_200_100, transaction: { message: message() }, meta: meta() };
    },
  } as unknown as Connection;
  await assert.rejects(
    () =>
      fetchDecisionHistory({
        rpcUrl: "http://127.0.0.1:1",
        programId: PROGRAM,
        connection,
        allowBlockScan: false,
      }),
    unchecked("sig-alt"),
  );
});

test("a block scan of a version 0 transaction with loadedAddresses absent beside a missing log body is not checked", async () => {
  const connection = {
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
            transaction: { signatures: ["sig-alt-block"], message: message() },
            meta: meta(),
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
        connection,
        allowBlockScan: true,
        maxSlots: 1,
      }),
    unchecked("sig-alt-block"),
  );
});
