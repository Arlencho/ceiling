// Security round 1, PR 213 (issue 156). The null-log guard tests
// meta.logMessages !== null. web3.js types that field optional(nullable),
// so a node that omits the key hands undefined through getTransaction and
// getBlock. txToView then folds undefined into logs: [] and the transaction
// is read as an empty log. A CPI payment behind an omitted log key is
// neither a decision nor a gap, and the file that omits it confirms.
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OUTER = "ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o";
const AGENT = "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w";
const SIG = "sig-omitted";

// Top level invokes the relay, the CPI list names the program, and the meta
// carries no logMessages key at all.
function omittedLogKeyBody() {
  return {
    slot: 3,
    blockTime: 1_790_200_100,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, PROGRAM, OUTER],
        compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Buffer.from([1]) }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: "" }] }],
    },
  };
}

function listedHistory(body: unknown) {
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: SIG, slot: 3, err: null, memo: null, blockTime: 1_790_200_100, confirmationStatus: "confirmed" as const }];
    },
    async getTransaction() {
      return body;
    },
  } as unknown as Connection;
  return fetchDecisionHistory({ rpcUrl: "http://127.0.0.1:1", programId: PROGRAM, connection, allowBlockScan: false });
}

function scannedHistory(body: { transaction: { message: unknown }; meta: unknown }) {
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
        transactions: [{ transaction: { signatures: [SIG], message: body.transaction.message }, meta: body.meta }],
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

test("a listed CPI to the program whose meta omits the logMessages key is not checked", async () => {
  const body = omittedLogKeyBody();
  assert.equal("logMessages" in body.meta, false);
  await assert.rejects(() => listedHistory(body), unchecked);
});

test("a block scan that finds a CPI to the program whose meta omits the logMessages key is not checked", async () => {
  await assert.rejects(() => scannedHistory(omittedLogKeyBody()), unchecked);
});

test("control: the same CPI with logMessages null is not checked", async () => {
  const body = omittedLogKeyBody();
  await assert.rejects(() => listedHistory({ ...body, meta: { ...body.meta, logMessages: null } }), unchecked);
});

test("control: the same CPI with an empty log array is absent, not a gap", async () => {
  const body = omittedLogKeyBody();
  const result = await listedHistory({ ...body, meta: { ...body.meta, logMessages: [] } });
  assert.equal(result.transactions.size, 1);
});

// Probe, not a finding on its own: the CPI target sits only in loadedAddresses
// and the node omits that optional block too. The guard cannot resolve the
// programIdIndex and txToView drops the transaction as not invoking the
// program. Noted for the fix; kept as todo so it does not gate this round.
test("probe: a CPI through a loaded address with loadedAddresses omitted beside a null log body", { todo: true }, async () => {
  const body = {
    slot: 3,
    blockTime: 1_790_200_100,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, OUTER],
        compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
        addressTableLookups: [{ accountKey: OUTER, writableIndexes: [], readonlyIndexes: [0] }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0], data: "" }] }],
      logMessages: null,
    },
  };
  await assert.rejects(() => listedHistory(body), unchecked);
});
