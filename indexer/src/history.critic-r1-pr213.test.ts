// Critic round 1, PR 213 (issue 156). The null-log guard reads the CPI list
// from meta.innerInstructions. The RPC documents that list as array or null,
// null when inner instruction recording was off, the same node switch that
// leaves logMessages null. meta itself is documented as object or null. A
// relay transaction that reaches the program only by CPI, with those bodies
// null and the program in its account keys, is neither a decision nor a gap:
// fetchDecisionHistory returns an empty population and the omission confirms.
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OUTER = "ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o";
const AGENT = "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w";
const SIG = "sig-relay";

// Top level invokes the relay. The program sits in the account keys, which
// is what a CPI to it requires. Nothing else about the body is readable.
function relayBody(meta: unknown) {
  return {
    slot: 3,
    blockTime: 1_790_200_100,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, PROGRAM, OUTER],
        compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Buffer.from([1]) }],
      },
    },
    meta,
  };
}

function history(meta: unknown) {
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: SIG, slot: 3, err: null, memo: null, blockTime: 1_790_200_100, confirmationStatus: "confirmed" as const }];
    },
    async getTransaction() {
      return relayBody(meta);
    },
  } as unknown as Connection;
  return fetchDecisionHistory({ rpcUrl: "http://127.0.0.1:1", programId: PROGRAM, connection, allowBlockScan: false });
}

const unchecked = (err: unknown) => {
  assert.equal(isTransportError(err), true);
  assert.match(err instanceof Error ? err.message : String(err), new RegExp(SIG));
  return true;
};

const cases: { name: string; meta: unknown }[] = [
  { name: "innerInstructions null beside logMessages null", meta: { err: null, innerInstructions: null, logMessages: null } },
  { name: "innerInstructions absent beside logMessages null", meta: { err: null, logMessages: null } },
  { name: "meta null", meta: null },
];

for (const c of cases) {
  test(`a listed relay with the program in its keys and ${c.name} is not checked`, async () => {
    await assert.rejects(() => history(c.meta), unchecked);
  });
}

test("control: the same relay with the CPI listed beside logMessages null is not checked", async () => {
  const meta = {
    err: null,
    innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: "" }] }],
    logMessages: null,
  };
  await assert.rejects(() => history(meta), unchecked);
});
