// Issue 149. A node failure on getGenesisHash during a bundle is transport
// (exit 3). JSON-RPC -32602 stays a rejection of the file.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { createFailoverConnection, isTransportError } from "../indexer/src/rpc.js";
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

function record(): DecisionRecord {
  const mandate = mandatePda(REAL_PROGRAM, OWNER, 3490n);
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
      purpose: "issue 149",
    },
    kind: "paid",
    amount: 10,
    counterparty: DEST.toBase58(),
    timestamp: 1_790_117_945,
    nonce: 1,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature: "5".repeat(87),
  });
}

function connection(code: number, message: string) {
  const fetchLike = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: unknown };
    const payload =
      body.method === "getGenesisHash"
        ? { error: { code, message } }
        : { result: null };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return createFailoverConnection(["http://127.0.0.1:1"], () => {}, {
    fetch: fetchLike,
    sleep: async () => {},
  });
}

function bundleOf(row: DecisionRecord) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: REAL_PROGRAM.toBase58(),
    scope: { type: "rule", mandate: row.mandate, from: null, to: null },
    decisions: [row],
  });
}

test("a JSON-RPC node failure on getGenesisHash for a bundle is transport, never a verdict", async () => {
  const row = record();
  await assert.rejects(
    () => assessBundle(bundleOf(row), RPC, connection(-32005, "Node is unhealthy"), OPTS),
    (err: unknown) => {
      assert.equal(isTransportError(err), true);
      const text = err instanceof Error ? err.message : String(err);
      assert.doesNotMatch(text, /VERDICT: CONFIRMED/);
      return true;
    },
  );
});

test("JSON-RPC -32602 on getGenesisHash for a bundle stays a failure of the file", async () => {
  const row = record();
  await assert.rejects(
    () => assessBundle(bundleOf(row), RPC, connection(-32602, "Invalid param"), OPTS),
    (err: unknown) => {
      assert.equal(isTransportError(err), false);
      const code = typeof err === "object" && err !== null && "code" in err ? (err as { code: unknown }).code : null;
      assert.equal(code, -32602);
      return true;
    },
  );
});
