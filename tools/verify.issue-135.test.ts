// Issue 135. A no-mandate date_range that omits a log-flooded charge does not confirm.
// The runtime cut is a bare "Log truncated" line, and the population names it.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { makeBundle } from "./bulk.js";
import { CHARGE_DISCRIMINATOR, TOKEN_PROGRAM_ID, u64Le } from "./lib.js";
import { assessBundle, type AssessOpts } from "./verify.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const MANDATE = new PublicKey("CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g");
const LEDGER = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const T = 1_790_200_000;
const OUTER = new PublicKey("ANoEgSnqyToTgu7WkRRgtVbcDEQiKmiV9gNWXqnXKX9o");

function floodedTx(): unknown {
  const data = Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(300_000n), u64Le(2n)]);
  const keys = [AGENT, DEST, LEDGER, MANDATE, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID, OUTER];
  return {
    slot: 2,
    blockTime: T,
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [
          { programIdIndex: 8, accountKeyIndexes: [], data: Buffer.from([1]) },
          { programIdIndex: 6, accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7], data },
        ],
      },
    },
    meta: {
      err: null,
      logMessages: [`Program ${OUTER.toBase58()} invoke [1]`, `Program log: ${"x".repeat(80)}`, "Log truncated"],
    },
  };
}

test("a no-mandate date_range that omits a truncated charge names Log truncated and does not confirm", async () => {
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction(signature: string) {
      return signature === "sig-hidden" ? floodedTx() : null;
    },
    async getAccountInfo() {
      return null;
    },
    async getSignaturesForAddress(_address: PublicKey, config?: { before?: string }) {
      if (config?.before) return [];
      return [
        {
          signature: "sig-hidden",
          slot: 2,
          err: null,
          memo: null,
          blockTime: T,
          confirmationStatus: "confirmed" as const,
        },
      ];
    },
  } as unknown as Connection;
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: null, from: T - 10, to: T + 10 },
    decisions: [],
  });
  const result = await assessBundle(bundle, RPC, conn, OPTS);
  assert.equal(result.ok, false, result.text);
  assert.equal(result.code, 1, result.text);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.match(result.text, /sig-hidden/);
  assert.match(result.text, /Log truncated/);
});
