import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  KIND_REFUSED,
  decodeBase58,
  kindName,
  parseRecord,
  reasonText,
  recordToJson,
  resolveProgramId,
  resolveRpc,
  u64Le,
} from "./lib.js";

test("reasonText matches the program table", () => {
  assert.equal(reasonText(0), "ok");
  assert.equal(reasonText(5), "over per-payment maximum");
  assert.equal(reasonText(6), "over remaining cap");
  assert.equal(reasonText(10), "account frozen");
  assert.equal(reasonText(99), "unknown");
});

test("kindName only names paid and refused", () => {
  assert.equal(kindName(KIND_PAID), "paid");
  assert.equal(kindName(KIND_REFUSED), "refused");
  assert.equal(kindName(0), null);
});

test("u64Le is little-endian", () => {
  const buf = u64Le(1n);
  assert.equal(buf[0], 1);
  assert.equal(buf[7], 0);
});

test("charge discriminator is 8 bytes", () => {
  assert.equal(CHARGE_DISCRIMINATOR.length, 8);
});

test("decodeBase58 round-trips a pubkey alphabet string of ones", () => {
  const decoded = decodeBase58("11111111");
  assert.ok(decoded.every((b) => b === 0));
});

const SAMPLE = {
  schema_version: 1,
  cluster: "devnet",
  genesis_hash: "5NrLCg7BRzhkDYxbiDy966tfYmVPfpprZamwXLALe3L5",
  program_id: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  mandate: "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g",
  limits: {
    cap: 500000000,
    per_tx_max: 60000000,
    expires_at: 1792465093,
    merchant: "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
    purpose: "charging",
  },
  kind: "refused",
  amount: 180000000,
  counterparty: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  timestamp: 1789871742,
  nonce: 2,
  reason_code: 5,
  reason_text: "over per-payment maximum",
  suggested_override: 180000000,
  signature: "3TtZbJJFYDGc29GemFgyMeJXc188MiZ7LfJnUUe1Y3vGrtYtZFZyyF9mwZAt31999nMdMFXBKvzThwXugHUm7cJp",
};

test("parseRecord accepts a complete version-1 object", () => {
  const rec = parseRecord(SAMPLE);
  assert.equal(rec.kind, "refused");
  assert.equal(rec.amount, 180000000n);
  assert.equal(rec.limits.purpose, "charging");
});

test("parseRecord rejects a missing field", () => {
  const { signature: _drop, ...rest } = SAMPLE;
  assert.throws(() => parseRecord(rest), /signature/);
});

test("parseRecord rejects a float amount", () => {
  assert.throws(() => parseRecord({ ...SAMPLE, amount: 1.5 }), /amount/);
});

test("parseRecord rejects a non-canonical reason later via verify, but accepts the JSON shape", () => {
  const rec = parseRecord({ ...SAMPLE, reason_text: "nope" });
  assert.equal(rec.reason_text, "nope");
});

test("recordToJson round-trips integers as numbers", () => {
  const rec = parseRecord(SAMPLE);
  const again = parseRecord(JSON.parse(recordToJson(rec)));
  assert.equal(again.amount, rec.amount);
  assert.equal(again.signature, rec.signature);
});

// Regression for the round 2 review of #37. Reason code 10 was added to the
// program while the off-chain consumers still stopped at 9, and verify.ts
// rejects a record whose code resolves to "unknown" as forged. A genuine
// frozen-account refusal therefore failed its own verifier. This pins the
// whole table rather than only the code that happened to be added, so the
// next code cannot reintroduce the same gap.
test("every reason code the program can emit resolves to text, not unknown", () => {
  for (let code = 0; code <= 10; code += 1) {
    assert.notEqual(
      reasonText(code),
      "unknown",
      `reason code ${code} does not resolve; verify.ts would report a genuine record as forged`,
    );
  }
  assert.equal(reasonText(10), "account frozen");
});

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "veto-tools-config-"));
  mkdirSync(join(dir, "keys"));
  return dir;
}

test("resolveRpc refuses to invent an endpoint", () => {
  const repo = tmpRepo();
  assert.throws(
    () => resolveRpc(undefined, repo, {}),
    /missing VETO_RPC/,
  );
});

test("resolveProgramId refuses to invent a program id", () => {
  const repo = tmpRepo();
  assert.throws(
    () => resolveProgramId(repo, {}),
    /missing VETO_PROGRAM_ID/,
  );
});

test("resolveRpc reads RPC from keys/devnet-addresses.env", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "keys", "devnet-addresses.env"), "RPC=http://from-file.test\n");
  assert.equal(resolveRpc(undefined, repo, {}), "http://from-file.test");
});

test("resolveProgramId reads PROGRAM_ID from keys/devnet-addresses.env", () => {
  const repo = tmpRepo();
  writeFileSync(
    join(repo, "keys", "devnet-addresses.env"),
    "PROGRAM_ID=11111111111111111111111111111111\n",
  );
  assert.equal(resolveProgramId(repo, {}).toBase58(), "11111111111111111111111111111111");
});
