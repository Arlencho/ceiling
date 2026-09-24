// Security round 1, PR 218 (issue 216). The fix reads a lookup-table
// transaction as unresolved when loadedAddresses is null, absent, or not an
// object. web3.js also lets through a loadedAddresses object whose arrays do
// not cover the table indexes. This file crosses every loadedAddresses shape
// with every log-body shape and every CPI-list shape, on the listed path and
// the block-scan path, for a program that lives only in the table. The
// expectation is computed from the claim under test: a missing log body on
// an unresolved or short table is not checked; a present log body is
// decoded; an empty log array is absent; a table that resolves to another
// program is absent.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { encodePaidLog } from "./events.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OUTER = "ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o";
const AGENT = "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TABLE = "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc";
const MANDATE = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const SIG = "sig-sec-r1-218";

type Body = { message: unknown; meta: unknown };

// Static keys hold the agent and the outer program. Index 2 is the relay
// target, which only the address table can fill.
function message() {
  return {
    staticAccountKeys: [AGENT, OUTER],
    compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
    addressTableLookups: [{ accountKey: TABLE, writableIndexes: [], readonlyIndexes: [0] }],
  };
}

const paidLogs = [
  `Program ${OUTER} invoke [1]`,
  `Program ${PROGRAM} invoke [2]`,
  "Program log: Instruction: Charge",
  encodePaidLog({ mandate: MANDATE, amount: 100_000n, nonce: 2n, spent: 100_000n }),
  `Program ${PROGRAM} success`,
  `Program ${OUTER} success`,
];

// Every loadedAddresses shape. The first four reach the guard through
// web3.js (null does not; it is here so the guard is pinned on it too).
// `covers` says whether index 2 resolves to the program.
const loadedShapes: { name: string; patch: (m: Record<string, unknown>) => Record<string, unknown>; covers: "program" | "other" | "none" }[] = [
  { name: "loadedAddresses omitted", patch: (m) => m, covers: "none" },
  { name: "loadedAddresses null", patch: (m) => ({ ...m, loadedAddresses: null }), covers: "none" },
  { name: "loadedAddresses short", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [] } }), covers: "none" },
  { name: "loadedAddresses resolves the program", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [PROGRAM] } }), covers: "program" },
  { name: "loadedAddresses resolves another program", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [OTHER] } }), covers: "other" },
];

const logShapes: { name: string; patch: (m: Record<string, unknown>) => Record<string, unknown>; kind: "missing" | "empty" | "paid" }[] = [
  { name: "logMessages null", patch: (m) => ({ ...m, logMessages: null }), kind: "missing" },
  { name: "logMessages omitted", patch: (m) => m, kind: "missing" },
  { name: "logMessages empty array", patch: (m) => ({ ...m, logMessages: [] }), kind: "empty" },
  { name: "logMessages with the Paid frame", patch: (m) => ({ ...m, logMessages: paidLogs }), kind: "paid" },
];

const cpiShapes: { name: string; patch: (m: Record<string, unknown>) => Record<string, unknown> }[] = [
  { name: "CPI list names index 2", patch: (m) => ({ ...m, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0], data: "" }] }] }) },
  { name: "CPI list omitted", patch: (m) => m },
  { name: "CPI list null", patch: (m) => ({ ...m, innerInstructions: null }) },
];

type Expect = "gap" | "absent" | "paid";

function expectation(covers: "program" | "other" | "none", logs: "missing" | "empty" | "paid"): Expect {
  if (logs === "paid") return "paid";
  if (logs === "empty") return "absent";
  // A missing log body on a table that resolves to another program is absent.
  // Every other table state cannot answer the invokes test, or answers yes.
  return covers === "other" ? "absent" : "gap";
}

function listedHistory(body: Body) {
  const connection = {
    async getSignaturesForAddress() {
      return [{ signature: SIG, slot: 3, err: null, memo: null, blockTime: 1_790_200_100, confirmationStatus: "confirmed" as const }];
    },
    async getTransaction() {
      return { slot: 3, blockTime: 1_790_200_100, transaction: { message: body.message }, meta: body.meta };
    },
  } as unknown as Connection;
  return fetchDecisionHistory({ rpcUrl: "http://127.0.0.1:1", programId: PROGRAM, connection, allowBlockScan: false });
}

function scannedHistory(body: Body) {
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
        transactions: [{ transaction: { signatures: [SIG], message: body.message }, meta: body.meta }],
      };
    },
  } as unknown as Connection;
  return fetchDecisionHistory({ rpcUrl: "http://127.0.0.1:1", programId: PROGRAM, connection, allowBlockScan: true, maxSlots: 1 });
}

const unchecked = (err: unknown) => {
  assert.equal(isTransportError(err), true);
  const text = err instanceof Error ? err.message : String(err);
  assert.match(text, new RegExp(SIG));
  assert.match(text, /null log body/);
  return true;
};

async function check(run: (body: Body) => ReturnType<typeof fetchDecisionHistory>, body: Body, expect: Expect) {
  if (expect === "gap") {
    await assert.rejects(() => run(body), unchecked);
    return;
  }
  const result = await run(body);
  if (expect === "absent") {
    assert.equal(result.decisions.length, 0);
    return;
  }
  assert.equal(result.decisions.length, 1, "the Paid frame in the log body is the decision");
  assert.equal(result.decisions[0]?.signature, SIG);
  assert.equal(result.decisions[0]?.kind, "paid");
  assert.equal(result.decisions[0]?.nonce, 2n);
}

for (const loaded of loadedShapes) {
  for (const logs of logShapes) {
    // A log body that names the program beside a table that resolves to
    // another program is a contradiction no node emits; not crossed.
    if (loaded.covers === "other" && logs.kind === "paid") continue;
    for (const cpi of cpiShapes) {
      const meta = cpi.patch(logs.patch(loaded.patch({ err: null })));
      const expect = expectation(loaded.covers, logs.kind);
      const label = `${loaded.name}, ${logs.name}, ${cpi.name}`;
      const verdict = expect === "gap" ? "is not checked" : expect === "absent" ? "is absent" : "is the Paid decision";
      test(`listed: lookup-table relay with ${label} ${verdict}`, async () => {
        await check(listedHistory, { message: message(), meta }, expect);
      });
      test(`block scan: lookup-table relay with ${label} ${verdict}`, async () => {
        await check(scannedHistory, { message: message(), meta }, expect);
      });
    }
  }
}

// A null meta has no table resolution and no log body.
for (const cpiName of ["meta null"]) {
  test(`listed: lookup-table relay with ${cpiName} is not checked`, async () => {
    await check(listedHistory, { message: message(), meta: null }, "gap");
  });
  test(`block scan: lookup-table relay with ${cpiName} is not checked`, async () => {
    await check(scannedHistory, { message: message(), meta: null }, "gap");
  });
}

// loadedAddresses present with neither array is a StructError in web3.js.
// Through a bare connection it must still never read as absent.
for (const [name, run] of [["listed", listedHistory], ["block scan", scannedHistory]] as const) {
  test(`${name}: lookup-table relay with an empty loadedAddresses object and a null log body never reads as absent`, async () => {
    await assert.rejects(() => run({ message: message(), meta: { err: null, logMessages: null, loadedAddresses: {} } }));
  });
}

// Failed transactions stay out on every table state.
for (const loaded of loadedShapes) {
  test(`listed control: ${loaded.name}, failed with a null log body stays out`, async () => {
    const meta = loaded.patch({ err: { InstructionError: [0, "Custom"] }, logMessages: null });
    const result = await listedHistory({ message: message(), meta });
    assert.equal(result.decisions.length, 0);
  });
}
