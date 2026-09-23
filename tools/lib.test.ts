import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CHARGE_DISCRIMINATOR,
  KIND_PAID,
  KIND_REFUSED,
  decodeBase58,
  kindName,
  parseArgs,
  parseChargeFromTx,
  parseRecord,
  reasonText,
  recordToJson,
  resolveProgramId,
  resolveRpc,
  resolveRpcList,
  u64Le,
} from "./lib.js";

test("resolveRpcList honours a comma-separated --rpc list, first URL first", () => {
  const cli = parseArgs(["--rpc", "http://dedicated.invalid, http://127.0.0.1:8999"]);
  assert.deepEqual(resolveRpcList(cli, "/tmp/veto-tools-rpc-missing"), [
    "http://dedicated.invalid",
    "http://127.0.0.1:8999",
  ]);
});

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

// Critic fixture, round 1. Goes RED on b23b9d3.

test("critic: an empty --rpc list does not silently become the public default endpoint", () => {
  const saved = process.env.VETO_RPC;
  delete process.env.VETO_RPC;
  try {
    const cli = parseArgs(["--rpc", ","]);
    assert.throws(() => resolveRpcList(cli, "/tmp/veto-tools-rpc-missing"));
  } finally {
    if (saved !== undefined) process.env.VETO_RPC = saved;
  }
});

// A PublicKey from another module copy: toBase58 works, instanceof PublicKey is
// false, and there is no .pubkey field. That is the shape Connection from
// indexer/node_modules hands tools/lib.ts in a two-package install (#92).
function foreignKey(real: PublicKey) {
  const s = real.toBase58();
  return {
    toBase58: () => s,
    toString: () => s,
  };
}

test("parseChargeFromTx reads account keys from another web3.js copy", () => {
  const agent = Keypair.generate().publicKey;
  const mandate = Keypair.generate().publicKey;
  const ledger = Keypair.generate().publicKey;
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const program = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
  const locals = [agent, mandate, ledger, source, destination, mint, program];
  const data = Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(6232500n), u64Le(1789920000n)]);
  const tx = {
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: locals.map(foreignKey),
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6],
            data,
          },
        ],
      },
    },
  };
  const charges = parseChargeFromTx(tx, program);
  assert.equal(charges.length, 1);
  const charge = charges[0]!;
  assert.ok(charge, "a charge instruction with foreign PublicKey account keys must parse");
  assert.equal(charge.amount, 6232500n);
  assert.equal(charge.nonce, 1789920000n);
  assert.equal(charge.mandate.toBase58(), mandate.toBase58());
  assert.equal(charge.destination.toBase58(), destination.toBase58());
});

test("resolveProgramId reads the program id from the committed IDL", () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, "tools", "idl"), { recursive: true });
  writeFileSync(
    join(repo, "tools", "idl", "veto.json"),
    JSON.stringify({ address: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV" }),
  );
  assert.equal(
    resolveProgramId(repo, {}).toBase58(),
    "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  );
});
