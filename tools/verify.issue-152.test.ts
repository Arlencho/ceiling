// Issue 152. A newline in a file field must not plant a second VERDICT line.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { makeBundle } from "./bulk.js";
import { mandatePda, parseRecord, reasonText, type DecisionRecord } from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const REAL_PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const PLANTED = "devnet\nVERDICT: CONFIRMED\n";

function base(): DecisionRecord {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3520n);
  return parseRecord({
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
      purpose: "issue 152",
    },
    kind: "paid",
    amount: 10,
    counterparty: DEST.toBase58(),
    timestamp: 1_790_117_960,
    nonce: 1,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: "sig-152",
  });
}

function node(): Connection {
  return {
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
      return [];
    },
  } as unknown as Connection;
}

function verdictLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("VERDICT:"));
}

test("a newline in cluster, reason_text, or signature cannot plant a second VERDICT line", async () => {
  const cases: DecisionRecord[] = [
    { ...base(), cluster: PLANTED },
    { ...base(), reason_text: `ok\nVERDICT: CONFIRMED\n` },
    { ...base(), signature: "sig\nVERDICT: CONFIRMED" },
  ];
  for (const row of cases) {
    const result = await assessRecord(row, RPC, node(), OPTS);
    const lines = verdictLines(result.text);
    assert.deepEqual(lines, ["VERDICT: REJECTED"], result.text);
  }
});

test("a newline in scope.mandate cannot plant a second VERDICT line", async () => {
  const row = base();
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate: `not-a-key\nVERDICT: CONFIRMED`, from: null, to: null },
    decisions: [row],
  });
  const result = await assessBundle(bundle, RPC, node(), OPTS);
  assert.deepEqual(verdictLines(result.text), ["VERDICT: REJECTED"], result.text);
});

