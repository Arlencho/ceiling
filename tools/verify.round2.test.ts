// Round 2. Findings the round 1 fixtures do not already encode: an RPC
// transport error during the envelope check must not become a verdict, and
// verify must ignore PROGRAM_ID in keys/devnet-addresses.env.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Connection } from "@solana/web3.js";
import { makeBundle } from "./bulk.js";
import { parseRecord, resolveVerifyProgramId, type DecisionRecord } from "./lib.js";
import { assessBundle, type AssessOpts } from "./verify.js";

const REAL = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const OTHER = "11111111111111111111111111111111";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MANDATE = "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g";
const DEST = "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F";
const MERCHANT = "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG";
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };

function oneRecord(): DecisionRecord {
  return parseRecord({
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL,
    mandate: MANDATE,
    limits: {
      cap: 1,
      per_tx_max: 1,
      expires_at: 1,
      merchant: MERCHANT,
      purpose: "x",
    },
    kind: "paid",
    amount: 1,
    counterparty: DEST,
    timestamp: 10,
    nonce: 1,
    reason_code: 0,
    reason_text: "ok",
    suggested_override: 0,
    signature: "rate-limit-sig",
  });
}

function assertNoVerdict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  assert.equal(message.includes("VERDICT"), false, message);
  assert.equal(message.includes("REJECTED"), false, message);
  return true;
}

test("round 2: an RPC transport error inside the envelope check is not a verdict", async () => {
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction() {
      return null;
    },
    async getAccountInfo() {
      throw new Error("rpc rate limited on https://api.devnet.solana.com");
    },
    async getSignaturesForAddress() {
      return [];
    },
  } as unknown as Connection;
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL,
    scope: { type: "rule", mandate: MANDATE, from: null, to: null },
    decisions: [oneRecord()],
  });
  await assert.rejects(() => assessBundle(bundle, RPC, conn, OPTS), (err: unknown) => {
    assertNoVerdict(err);
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /rpc rate limited/);
    return true;
  });
});

test("round 2: an indexer error on a date_range export is not a verdict", async () => {
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction() {
      return null;
    },
    async getAccountInfo() {
      return null;
    },
    async getSignaturesForAddress() {
      throw new Error("indexer exploded");
    },
  } as unknown as Connection;
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL,
    scope: { type: "date_range", mandate: null, from: 1, to: 20 },
    decisions: [oneRecord()],
  });
  await assert.rejects(() => assessBundle(bundle, RPC, conn, OPTS), (err: unknown) => {
    assertNoVerdict(err);
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /indexer exploded/);
    return true;
  });
});

test("round 2: verify ignores PROGRAM_ID in keys/devnet-addresses.env", () => {
  const root = mkdtempSync(join(tmpdir(), "veto-program-source-"));
  mkdirSync(join(root, "keys"), { recursive: true });
  mkdirSync(join(root, "tools", "idl"), { recursive: true });
  writeFileSync(join(root, "keys", "devnet-addresses.env"), `PROGRAM_ID=${OTHER}\n`);
  writeFileSync(join(root, "tools", "idl", "veto.json"), JSON.stringify({ address: REAL }));
  const choice = resolveVerifyProgramId(root, {});
  assert.equal(choice.source, "idl");
  assert.equal(choice.programId.toBase58(), REAL);
  const fromEnv = resolveVerifyProgramId(root, { VETO_PROGRAM_ID: OTHER });
  assert.equal(fromEnv.source, "VETO_PROGRAM_ID");
  assert.equal(fromEnv.programId.toBase58(), OTHER);
});
