import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KIND_OPENED, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX } from "./constants.js";
import { decodeLedgerAccount } from "./ring.js";

test("decodes a live 32-entry ring without inventing wrapped rows", () => {
  const b64 = readFileSync(new URL("../fixtures/ledger-account.b64", import.meta.url), "utf8").trim();
  const data = Buffer.from(b64, "base64");
  const ring = decodeLedgerAccount("42yPoqpxsJoZuC62859dYHNy5pgqkGkZ2oxSaoM2KHTX", data);
  assert.equal(ring.total, 3);
  assert.equal(ring.head, 3);
  assert.equal(ring.entries.length, 3);
  assert.equal(ring.mandate, "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g");

  assert.equal(ring.entries[0]?.kind, KIND_OPENED);
  assert.equal(ring.entries[0]?.amount, 100000000n);
  assert.equal(ring.entries[0]?.counterparty, "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");

  assert.equal(ring.entries[1]?.kind, KIND_PAID);
  assert.equal(ring.entries[1]?.amount, 446000n);
  assert.equal(ring.entries[1]?.nonce, 1789855200n);
  assert.equal(ring.entries[1]?.counterparty, "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
  assert.equal(ring.entries[1]?.reason, 0);

  assert.equal(ring.entries[2]?.kind, KIND_REFUSED);
  assert.equal(ring.entries[2]?.amount, 519500n);
  assert.equal(ring.entries[2]?.nonce, 1789860600n);
  assert.equal(ring.entries[2]?.reason, REASON_OVER_PER_TX_MAX);
  assert.equal(ring.entries[2]?.suggestedOverride, 519500n);
  assert.equal(ring.entries[2]?.counterparty, "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
});
