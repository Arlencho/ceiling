// Security round 2, PR 218 (issue 216). The round 1 fix decides that a
// lookup table is unresolved when a programIdIndex is at or past the
// resolved key list. That catches a loaded set that is short at the tail.
// A loaded set missing an entry from the front shifts every later key one
// slot, so the CPI index still resolves, to the wrong program, and the
// relay reads as absent. This file crosses a two-entry table with every
// loaded-set shape (full, shifted short, tail short, one array only, full
// but another program) against every log-body and CPI-list spelling, on
// the listed path and the block-scan path. The expectation is computed
// from the claim under test: any loaded set shorter than the table beside
// a missing log body is not checked; a full set that resolves the program
// is not checked unless a present CPI list shows no call; a full set that
// resolves another program is absent; a present Paid frame is decoded.
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
const OTHER2 = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TABLE = "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc";
const MANDATE = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const SIG = "sig-sec-r2-218";

type Body = { message: unknown; meta: unknown };

// Static keys hold the agent and the outer program. The table declares two
// entries: index 2 is the relay target, index 3 is a second program.
function message(withLookups = true): Record<string, unknown> {
  const m: Record<string, unknown> = {
    staticAccountKeys: [AGENT, OUTER],
    compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
  };
  if (withLookups) m.addressTableLookups = [{ accountKey: TABLE, writableIndexes: [], readonlyIndexes: [0, 1] }];
  return m;
}

const paidLogs = [
  `Program ${OUTER} invoke [1]`,
  `Program ${PROGRAM} invoke [2]`,
  "Program log: Instruction: Charge",
  encodePaidLog({ mandate: MANDATE, amount: 100_000n, nonce: 2n, spent: 100_000n }),
  `Program ${PROGRAM} success`,
  `Program ${OUTER} success`,
];

type Covers = "program" | "other" | "short";
type Patch = (m: Record<string, unknown>) => Record<string, unknown>;

// `covers` says what the table state means for index 2: it resolves to the
// program, it resolves to another program on a full set, or the set is
// shorter than the table declares.
const loadedShapes: { name: string; patch: Patch; covers: Covers }[] = [
  { name: "full set, program at index 2", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [PROGRAM, OTHER] } }), covers: "program" },
  { name: "shifted short set, first entry dropped", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [OTHER] } }), covers: "short" },
  { name: "tail short set, last entry dropped", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [PROGRAM] } }), covers: "short" },
  { name: "empty set", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [] } }), covers: "short" },
  { name: "readonly array only", patch: (m) => ({ ...m, loadedAddresses: { readonly: [PROGRAM, OTHER] } }), covers: "program" },
  { name: "writable array only", patch: (m) => ({ ...m, loadedAddresses: { writable: [PROGRAM, OTHER] } }), covers: "program" },
  { name: "full set, another program at index 2", patch: (m) => ({ ...m, loadedAddresses: { writable: [], readonly: [OTHER, OTHER2] } }), covers: "other" },
];

const logShapes: { name: string; patch: Patch; kind: "missing" | "empty" | "paid" }[] = [
  { name: "logMessages null", patch: (m) => ({ ...m, logMessages: null }), kind: "missing" },
  { name: "logMessages omitted", patch: (m) => m, kind: "missing" },
  { name: "logMessages empty array", patch: (m) => ({ ...m, logMessages: [] }), kind: "empty" },
  { name: "logMessages with the Paid frame", patch: (m) => ({ ...m, logMessages: paidLogs }), kind: "paid" },
];

const cpiShapes: { name: string; patch: Patch; kind: "names" | "empty" | "missing" }[] = [
  { name: "CPI list names index 2", patch: (m) => ({ ...m, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0], data: "" }] }] }), kind: "names" },
  { name: "CPI list empty array", patch: (m) => ({ ...m, innerInstructions: [] }), kind: "empty" },
  { name: "CPI list omitted", patch: (m) => m, kind: "missing" },
  { name: "CPI list null", patch: (m) => ({ ...m, innerInstructions: null }), kind: "missing" },
];

type Expect = "gap" | "absent" | "paid";

function expectation(covers: Covers, logs: "missing" | "empty" | "paid", cpi: "names" | "empty" | "missing"): Expect {
  if (logs === "paid") return "paid";
  if (logs === "empty") return "absent";
  // A set shorter than the table cannot answer the invokes test at all.
  if (covers === "short") return "gap";
  if (covers === "other") return "absent";
  // A full set that resolves the program: a present CPI list that shows no
  // call is the checked answer; a call or a missing list is the gap.
  return cpi === "empty" ? "absent" : "gap";
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

const paths = [["listed", listedHistory], ["block scan", scannedHistory]] as const;

for (const loaded of loadedShapes) {
  for (const logs of logShapes) {
    // A Paid frame beside a full set that resolves another program is a
    // contradiction no node emits; not crossed.
    if (loaded.covers === "other" && logs.kind === "paid") continue;
    for (const cpi of cpiShapes) {
      const meta = cpi.patch(logs.patch(loaded.patch({ err: null })));
      const expect = expectation(loaded.covers, logs.kind, cpi.kind);
      const label = `${loaded.name}, ${logs.name}, ${cpi.name}`;
      const verdict = expect === "gap" ? "is not checked" : expect === "absent" ? "is absent" : "is the Paid decision";
      for (const [name, run] of paths) {
        test(`${name}: two-entry table relay with ${label} ${verdict}`, async () => {
          await check(run, { message: message(), meta }, expect);
        });
      }
    }
  }
}

// Failed transactions stay out on every set shape.
for (const loaded of loadedShapes) {
  test(`listed control: ${loaded.name}, failed with a null log body stays out`, async () => {
    const meta = loaded.patch({ err: { InstructionError: [0, "Custom"] }, logMessages: null });
    const result = await listedHistory({ message: message(), meta });
    assert.equal(result.decisions.length, 0);
  });
}

// web3.js types addressTableLookups as optional on the transaction message
// and optional or null on the block message. A version 0 message with that
// list omitted, beside an omitted loaded set and a missing log body, is
// unresolved on both paths. A present Paid frame on the same message is
// still the decision. A legacy message has no lookup list; on the listed
// path a signature returned for the program whose keys omit it is a
// contradiction, and on the block-scan path that transaction is absent.
for (const [name, run] of paths) {
  test(`${name}: relay with the lookups stripped, loaded set omitted, CPI list names index 2, null log body is not checked`, async () => {
    const meta = { err: null, logMessages: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0], data: "" }] }] };
    await check(run, { message: message(false), meta }, "gap");
  });
  for (const cpi of cpiShapes.filter((c) => c.kind === "missing")) {
    test(`${name}: relay with the lookups stripped, loaded set omitted, ${cpi.name}, null log body is not checked`, async () => {
      const meta = cpi.patch({ err: null, logMessages: null });
      await check(run, { message: message(false), meta }, "gap");
    });
  }
  test(`${name}: relay with the lookups stripped and the Paid frame is the Paid decision`, async () => {
    const meta = { err: null, logMessages: paidLogs };
    await check(run, { message: message(false), meta }, "paid");
  });
}

const legacyOmitsProgram = {
  accountKeys: [AGENT, OUTER],
  instructions: [{ programIdIndex: 1, accounts: [0], data: "" }],
};

test("listed: legacy keys omit the program beside a null log body is not checked", async () => {
  await check(listedHistory, { message: legacyOmitsProgram, meta: { err: null, logMessages: null } }, "gap");
});

test("block scan: legacy keys omit the program beside a null log body is absent", async () => {
  await check(scannedHistory, { message: legacyOmitsProgram, meta: { err: null, logMessages: null } }, "absent");
});
