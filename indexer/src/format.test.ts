import assert from "node:assert/strict";
import test from "node:test";
import { formatTable, decisionToJson } from "./format.js";
import type { Decision } from "./types.js";

const row: Decision = {
  signature: "sig111",
  slot: 8,
  timestamp: 1_700_000_000,
  mandate: "man",
  amount: 500000n,
  nonce: 1n,
  counterparty: "dest",
  kind: "paid",
  reason: 0,
  reasonText: "ok",
  suggestedOverride: 0n,
};

test("table includes the fields the app and export consume", () => {
  const table = formatTable([row]);
  for (const piece of ["TIME", "KIND", "AMOUNT", "REASON", "OVERRIDE", "COUNTERPARTY", "SIGNATURE", "paid", "500000", "sig111", "dest"]) {
    assert.ok(table.includes(piece), `missing ${piece}`);
  }
});

test("json serializes amounts as decimal strings, never floats", () => {
  const json = decisionToJson(row);
  assert.equal(json.amount, "500000");
  assert.equal(json.suggested_override, "0");
  assert.equal(typeof json.amount, "string");
});
