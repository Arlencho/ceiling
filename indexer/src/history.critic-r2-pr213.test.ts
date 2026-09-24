// Critic round 2, PR 213 (issue 156). Round 1 proved the three missing-body
// shapes on the listed path. This file runs the same three shapes through the
// block-scan path, and pins the regression the fix must not cause: an empty
// log array beside a null or absent CPI list is an empty log on both paths,
// and a failed transaction with no log body stays out without a gap.
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OUTER = "ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o";
const AGENT = "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w";
const SIG = "sig-relay-r2";

const relayMessage = {
  staticAccountKeys: [AGENT, PROGRAM, OUTER],
  compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Buffer.from([1]) }],
};

function listedHistory(meta: unknown) {
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: SIG, slot: 3, err: null, memo: null, blockTime: 1_790_200_100, confirmationStatus: "confirmed" as const }];
    },
    async getTransaction() {
      return { slot: 3, blockTime: 1_790_200_100, transaction: { message: relayMessage }, meta };
    },
  } as unknown as Connection;
  return fetchDecisionHistory({ rpcUrl: "http://127.0.0.1:1", programId: PROGRAM, connection, allowBlockScan: false });
}

function scannedHistory(meta: unknown) {
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
        transactions: [{ transaction: { signatures: [SIG], message: relayMessage }, meta }],
      };
    },
  } as unknown as Connection;
  return fetchDecisionHistory({ rpcUrl: "http://127.0.0.1:1", programId: PROGRAM, connection, allowBlockScan: true, maxSlots: 1 });
}

const unchecked = (err: unknown) => {
  assert.equal(isTransportError(err), true);
  assert.match(err instanceof Error ? err.message : String(err), new RegExp(SIG));
  return true;
};

const gaps: { name: string; meta: unknown }[] = [
  { name: "innerInstructions null beside logMessages null", meta: { err: null, innerInstructions: null, logMessages: null } },
  { name: "innerInstructions absent beside logMessages null", meta: { err: null, logMessages: null } },
  { name: "innerInstructions null and logMessages absent", meta: { err: null, innerInstructions: null } },
  { name: "meta null", meta: null },
];

for (const c of gaps) {
  test(`block scan: a relay with the program in its keys and ${c.name} is not checked`, async () => {
    await assert.rejects(() => scannedHistory(c.meta), unchecked);
  });
  test(`listed: a relay with the program in its keys and ${c.name} is not checked`, async () => {
    await assert.rejects(() => listedHistory(c.meta), unchecked);
  });
}

// Regression: an empty log array is an empty log, whatever the CPI list says.
const empties: { name: string; meta: unknown }[] = [
  { name: "innerInstructions null", meta: { err: null, innerInstructions: null, logMessages: [] } },
  { name: "innerInstructions absent", meta: { err: null, logMessages: [] } },
];

for (const c of empties) {
  test(`listed: an empty log array beside ${c.name} is absent, not a gap`, async () => {
    const result = await listedHistory(c.meta);
    assert.equal(result.transactions.size, 1);
    assert.equal(result.decisions.length, 0);
  });
  test(`block scan: an empty log array beside ${c.name} is absent, not a gap`, async () => {
    const result = await scannedHistory(c.meta);
    assert.equal(result.usedBlockScan, true);
    assert.equal(result.slotsScanned, 1);
    assert.equal(result.decisions.length, 0);
  });
}

test("block scan: a failed relay with no log body stays out without a gap", async () => {
  const result = await scannedHistory({ err: { InstructionError: [0, "Custom"] }, innerInstructions: null, logMessages: null });
  assert.equal(result.usedBlockScan, true);
  assert.equal(result.decisions.length, 0);
});
