// Security round 2, PR 213 (issue 156). Round 1 proved an omitted logMessages
// key beside a listed CPI confirms the file that omits the payment. The fix
// (168d1b7) reads a missing body as null, an omitted key, a non-array, or a
// null meta, on both paths. This file crosses every spelling of a missing log
// body with every spelling of a missing CPI list and every placement of the
// program in the transaction keys, on the listed path and the block-scan
// path. Two shapes stay absent on purpose: an empty CPI list, and a CPI list
// that names another program. Issue 216 is live: a program reachable only
// through an address lookup table, with loadedAddresses omitted or with meta
// null, is not checked when the log body is missing. web3.js types
// loadedAddresses optional and meta nullable, so both survive getTransaction
// and getBlock.
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { fetchDecisionHistory } from "./history.js";
import { isTransportError } from "./rpc.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OUTER = "ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o";
const AGENT = "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TABLE = "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc";
const SIG = "sig-sec-r2";

type Body = { message: unknown; meta: unknown };

// Every spelling of a missing log body that the guard should read as the
// same gap. The first two survive web3.js; the rest only reach the guard
// through a connection that skips its parser, and the guard must still not
// fold them into an empty log.
const missingLogs: { name: string; patch: (meta: Record<string, unknown>) => Record<string, unknown> }[] = [
  { name: "logMessages null", patch: (m) => ({ ...m, logMessages: null }) },
  { name: "logMessages omitted", patch: (m) => m },
  { name: "logMessages explicit undefined", patch: (m) => ({ ...m, logMessages: undefined }) },
  { name: "logMessages a string", patch: (m) => ({ ...m, logMessages: "Program log: VETO PAID" }) },
  { name: "logMessages an object", patch: (m) => ({ ...m, logMessages: { 0: "Program log" } }) },
  { name: "logMessages a number", patch: (m) => ({ ...m, logMessages: 0 }) },
];

// Every spelling of a missing CPI list.
const missingInner: { name: string; patch: (meta: Record<string, unknown>) => Record<string, unknown> }[] = [
  { name: "innerInstructions null", patch: (m) => ({ ...m, innerInstructions: null }) },
  { name: "innerInstructions omitted", patch: (m) => m },
  { name: "innerInstructions explicit undefined", patch: (m) => ({ ...m, innerInstructions: undefined }) },
  { name: "innerInstructions a string", patch: (m) => ({ ...m, innerInstructions: "none" }) },
];

const cpiTo = (index: number) => [{ index: 0, instructions: [{ programIdIndex: index, accounts: [0], data: "" }] }];

// Program placements. `expectGap` is the rule the fix states: a missing body
// is a gap when the transaction invokes the program at top level or in a
// present CPI list, or when the CPI list is itself missing and the program is
// in the keys the node handed over.
const placements: {
  name: string;
  message: unknown;
  meta: Record<string, unknown>;
  withInner: "cpi" | "other" | "empty" | "missing";
  expectGap: boolean;
}[] = [
  {
    name: "top-level invoke of the program",
    message: {
      staticAccountKeys: [AGENT, PROGRAM],
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
    },
    meta: { err: null },
    withInner: "missing",
    expectGap: true,
  },
  {
    name: "top-level invoke of the program with an empty CPI list",
    message: {
      staticAccountKeys: [AGENT, PROGRAM],
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
    },
    meta: { err: null, innerInstructions: [] },
    withInner: "empty",
    expectGap: true,
  },
  {
    name: "legacy message, top-level invoke of the program",
    message: {
      accountKeys: [AGENT, PROGRAM],
      instructions: [{ programIdIndex: 1, accounts: [0], data: "" }],
    },
    meta: { err: null },
    withInner: "missing",
    expectGap: true,
  },
  {
    name: "relay with a CPI to the program in a present list",
    message: {
      staticAccountKeys: [AGENT, PROGRAM, OUTER],
      compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Buffer.from([1]) }],
    },
    meta: { err: null, innerInstructions: cpiTo(1) },
    withInner: "cpi",
    expectGap: true,
  },
  {
    name: "relay that lists the program with a missing CPI list",
    message: {
      staticAccountKeys: [AGENT, PROGRAM, OUTER],
      compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Buffer.from([1]) }],
    },
    meta: { err: null },
    withInner: "missing",
    expectGap: true,
  },
  {
    name: "relay that lists the program with an empty CPI list (accepted as absent)",
    message: {
      staticAccountKeys: [AGENT, PROGRAM, OUTER],
      compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Buffer.from([1]) }],
    },
    meta: { err: null, innerInstructions: [] },
    withInner: "empty",
    expectGap: false,
  },
  {
    name: "relay that lists the program with a CPI list naming another program (accepted as absent)",
    message: {
      staticAccountKeys: [AGENT, PROGRAM, OUTER, OTHER],
      compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Buffer.from([1]) }],
    },
    meta: { err: null, innerInstructions: cpiTo(3) },
    withInner: "other",
    expectGap: false,
  },
  {
    name: "relay with a CPI to the program through a loaded address, loadedAddresses present",
    message: {
      staticAccountKeys: [AGENT, OUTER],
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
      addressTableLookups: [{ accountKey: TABLE, writableIndexes: [], readonlyIndexes: [0] }],
    },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [PROGRAM] }, innerInstructions: cpiTo(2) },
    withInner: "cpi",
    expectGap: true,
  },
  {
    name: "relay that lists the program only in loadedAddresses with a missing CPI list",
    message: {
      staticAccountKeys: [AGENT, OUTER],
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
      addressTableLookups: [{ accountKey: TABLE, writableIndexes: [], readonlyIndexes: [0] }],
    },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [PROGRAM] } },
    withInner: "missing",
    expectGap: true,
  },
  {
    name: "relay with a CPI to the program through a loaded address, loadedAddresses omitted",
    message: {
      staticAccountKeys: [AGENT, OUTER],
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
      addressTableLookups: [{ accountKey: TABLE, writableIndexes: [], readonlyIndexes: [0] }],
    },
    meta: { err: null, innerInstructions: cpiTo(2) },
    withInner: "cpi",
    expectGap: true,
  },
  {
    name: "transaction that does not list the program at all",
    message: {
      staticAccountKeys: [AGENT, OUTER],
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
    },
    meta: { err: null },
    withInner: "missing",
    expectGap: false,
  },
];

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
  assert.match(err instanceof Error ? err.message : String(err), new RegExp(SIG));
  return true;
};

async function expectListed(body: Body, gap: boolean) {
  if (gap) {
    await assert.rejects(() => listedHistory(body), unchecked);
    return;
  }
  const result = await listedHistory(body);
  assert.equal(result.transactions.size, 1);
  assert.equal(result.decisions.length, 0);
}

async function expectScanned(body: Body, gap: boolean) {
  if (gap) {
    await assert.rejects(() => scannedHistory(body), unchecked);
    return;
  }
  const result = await scannedHistory(body);
  assert.equal(result.usedBlockScan, true);
  assert.equal(result.slotsScanned, 1);
  assert.equal(result.decisions.length, 0);
}

for (const p of placements) {
  const inners = p.withInner === "missing" ? missingInner : [{ name: `CPI list ${p.withInner}`, patch: (m: Record<string, unknown>) => m }];
  for (const inner of inners) {
    for (const logs of missingLogs) {
      const meta = logs.patch(inner.patch(p.meta));
      const label = `${p.name}, ${inner.name}, ${logs.name}`;
      const verdict = p.expectGap ? "is not checked" : "is absent, not a gap";
      test(`listed: ${label} ${verdict}`, async () => {
        await expectListed({ message: p.message, meta }, p.expectGap);
      });
      test(`block scan: ${label} ${verdict}`, async () => {
        await expectScanned({ message: p.message, meta }, p.expectGap);
      });
    }
  }
}

// meta null and meta omitted. Through web3.js only null survives; the guard
// must treat both as the same missing body.
const missingMeta: { name: string; meta: unknown }[] = [
  { name: "meta null", meta: null },
  { name: "meta explicit undefined", meta: undefined },
];

for (const m of missingMeta) {
  for (const p of placements.filter((x) => x.withInner === "missing")) {
    const label = `${p.name}, ${m.name}`;
    // A null meta leaves loadedAddresses unresolved. A placement that names
    // an address table still cannot answer the invokes test.
    const verdict = p.expectGap ? "is not checked" : "is absent, not a gap";
    test(`listed: ${label} ${verdict}`, async () => {
      await expectListed({ message: p.message, meta: m.meta }, p.expectGap);
    });
    test(`block scan: ${label} ${verdict}`, async () => {
      await expectScanned({ message: p.message, meta: m.meta }, p.expectGap);
    });
  }
}

// Controls. An empty log array is an empty log on every placement, and a
// failed transaction stays out whatever the body says.
for (const p of placements) {
  test(`listed control: ${p.name}, logMessages [] is absent, not a gap`, async () => {
    await expectListed({ message: p.message, meta: { ...p.meta, logMessages: [] } }, false);
  });
  test(`block scan control: ${p.name}, logMessages [] is absent, not a gap`, async () => {
    await expectScanned({ message: p.message, meta: { ...p.meta, logMessages: [] } }, false);
  });
}

for (const p of placements.filter((x) => x.expectGap)) {
  test(`listed control: ${p.name}, failed with logMessages null stays out`, async () => {
    const result = await listedHistory({ message: p.message, meta: { ...p.meta, err: { InstructionError: [0, "Custom"] }, logMessages: null } });
    assert.equal(result.decisions.length, 0);
  });
  test(`block scan control: ${p.name}, failed with logMessages null stays out`, async () => {
    const result = await scannedHistory({ message: p.message, meta: { ...p.meta, err: { InstructionError: [0, "Custom"] }, logMessages: null } });
    assert.equal(result.decisions.length, 0);
  });
}
