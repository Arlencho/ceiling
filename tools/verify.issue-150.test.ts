// Issue 150. A block-scan fallback that hears "block not available" has not
// checked that slot. The file must not confirm.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, SolanaJSONRPCError, type Connection } from "@solana/web3.js";
import { isTransportError } from "../indexer/src/rpc.js";
import { makeBundle } from "./bulk.js";
import { assessBundle, type AssessOpts } from "./verify.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {}, allowBlockScan: true, pageSize: 25 };

function rpcError(code: number, message: string): SolanaJSONRPCError {
  return new SolanaJSONRPCError({ code, message }, "failed");
}

function node(): Connection {
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getSignaturesForAddress() {
      return [];
    },
    async getSlot() {
      return 10;
    },
    async getFirstAvailableBlock() {
      return 9;
    },
    async getBlocks() {
      return [9, 10];
    },
    async getBlock(slot: number) {
      if (slot === 9) throw rpcError(-32004, "Block not available for slot 9");
      return { blockTime: 1_790_200_000, transactions: [] };
    },
  } as unknown as Connection;
}

test("a block scan that cannot read one slot does not confirm a date_range that omits it", async () => {
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: null, from: 1_790_000_000, to: 1_790_300_000 },
    decisions: [],
  });
  let code = 0;
  let text = "";
  try {
    const verdict = await assessBundle(bundle, RPC, node(), OPTS);
    code = verdict.code;
    text = verdict.text;
  } catch (err) {
    code = isTransportError(err) ? 3 : 1;
    text = err instanceof Error ? err.message : String(err);
  }
  assert.equal(code, 3, text);
  assert.doesNotMatch(text, /CONFIRMED/);
});
