// Issue 151. A signature that is not 64 bytes of base58 is a rejected file.
// It must not reach the node and stall the bundle at exit 3.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { makeBundle } from "./bulk.js";
import { mandatePda, parseRecord, reasonText, type DecisionRecord } from "./lib.js";
import { assessBundle, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const HONEST = "5".repeat(87);
const SURROGATE = `${"5".repeat(86)}\ud800`;
const OVERSIZE = "5".repeat(200_000);

function plain(signature: string): Record<string, unknown> {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3510n);
  return {
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: REAL_PROGRAM.toBase58(),
    mandate: mandate.toBase58(),
    limits: {
      cap: 1_000_000,
      per_tx_max: 500_000,
      expires_at: 1_797_713_870,
      merchant: MERCHANT.toBase58(),
      purpose: "issue 151",
    },
    kind: "paid",
    amount: 10,
    counterparty: DEST.toBase58(),
    timestamp: 1_790_117_960,
    nonce: 1,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature,
  };
}

function honest(): DecisionRecord {
  return parseRecord(plain(HONEST));
}

function bundle(row: DecisionRecord) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate: row.mandate, from: null, to: null },
    decisions: [row],
  });
}

function node(calls: { n: number }): Connection {
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction() {
      calls.n += 1;
      return null;
    },
    async getAccountInfo() {
      return null;
    },
    async getSignaturesForAddress() {
      return [];
    },
  } as unknown as Connection;
}

async function rejected(signature: string) {
  const calls = { n: 0 };
  const row = { ...honest(), signature };
  const result = await assessBundle(bundle(row), RPC, node(calls), OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.doesNotMatch(result.text, /was not checked/);
  assert.doesNotMatch(result.text, /CONFIRMED/);
  assert.equal(calls.n, 0, `node was called ${calls.n} times`);
}

test("a lone surrogate signature is rejected as a file and never sent to the node", async () => {
  assert.throws(() => parseRecord(plain(SURROGATE)), /signature/);
  await rejected(SURROGATE);
});

test("an oversize signature is rejected as a file and never sent to the node", async () => {
  assert.throws(() => parseRecord(plain(OVERSIZE)), /signature/);
  await rejected(OVERSIZE);
});
