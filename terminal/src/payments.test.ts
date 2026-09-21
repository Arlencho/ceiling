import assert from "node:assert/strict";
import test from "node:test";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { fetchPayments } from "./payments.js";

const TOKEN = "11111111111111111111111111111111";

function paymentTx(postAmount: string, preAmount: string, blockTime: number): ParsedTransactionWithMeta {
  const pubkey = new PublicKey(TOKEN);
  return {
    slot: 1,
    transaction: {
      signatures: [],
      message: {
        accountKeys: [{ pubkey, signer: false, writable: true }],
      },
    },
    meta: {
      err: null,
      fee: 0,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [
        {
          accountIndex: 0,
          mint: "Mint",
          owner: "Owner",
          uiTokenAmount: { amount: preAmount, decimals: 6, uiAmount: null, uiAmountString: preAmount },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint: "Mint",
          owner: "Owner",
          uiTokenAmount: { amount: postAmount, decimals: 6, uiAmount: null, uiAmountString: postAmount },
        },
      ],
    },
    blockTime,
  } as unknown as ParsedTransactionWithMeta;
}

test("fetchPayments loads every signature in one batch call", async () => {
  const txA = paymentTx("100", "40", 1_700_000_000);
  const txB = paymentTx("250", "100", 1_700_000_100);
  let singleCalls = 0;
  let batchCalls = 0;
  let batched: string[] | null = null;
  const connection = {
    getSignaturesForAddress: async () => [{ signature: "SigA" }, { signature: "SigB" }],
    getParsedTransaction: async () => {
      singleCalls += 1;
      return txA;
    },
    getParsedTransactions: async (signatures: string[]) => {
      batchCalls += 1;
      batched = signatures;
      return [txA, txB];
    },
  } as unknown as Connection;

  const payments = await fetchPayments({ connection, tokenAccount: TOKEN });

  assert.equal(singleCalls, 0, "one-transaction-per-signature is the old loop");
  assert.equal(batchCalls, 1);
  assert.deepEqual(batched, ["SigA", "SigB"]);
  assert.equal(payments.length, 2);
  assert.equal(payments[0]?.signature, "SigA");
  assert.equal(payments[0]?.amount, 60n);
  assert.equal(payments[1]?.signature, "SigB");
  assert.equal(payments[1]?.amount, 150n);
});

// Round 1 critic fixture for #74: count requests on the wire, not method
// calls on a mock. A real Connection with a fake fetch answers JSON-RPC.

async function wirePosts(signatureCount: number): Promise<string[]> {
  const posts: string[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as unknown;
    if (Array.isArray(body)) {
      posts.push(`batch[${String(body.length)}]`);
      const answers = (body as Array<{ id: unknown }>).map((r) => ({ jsonrpc: "2.0", id: r.id, result: null }));
      return new Response(JSON.stringify(answers), { status: 200, headers: { "content-type": "application/json" } });
    }
    const req = body as { id: unknown; method: string };
    posts.push(req.method);
    const sigs = Array.from({ length: signatureCount }, (_, i) => ({
      signature: `Sig${String(i)}`,
      slot: 1 + i,
      err: null,
      memo: null,
      blockTime: 1_700_000_000 + i,
      confirmationStatus: "confirmed",
    }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: sigs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const connection = new Connection("http://rpc.invalid", { fetch: fetchImpl as unknown as typeof fetch });
  await fetchPayments({ connection, tokenAccount: TOKEN });
  return posts;
}

test("fetchPayments makes two requests on the wire for any number of signatures", async () => {
  const rows: Array<{ count: number; posts: string[] }> = [
    { count: 1, posts: ["getSignaturesForAddress", "batch[1]"] },
    { count: 5, posts: ["getSignaturesForAddress", "batch[5]"] },
    { count: 10, posts: ["getSignaturesForAddress", "batch[10]"] },
  ];
  for (const row of rows) {
    assert.deepEqual(await wirePosts(row.count), row.posts, `${String(row.count)} signatures`);
  }
});

test("fetchPayments sends no empty batch for an account with no history", async () => {
  assert.deepEqual(await wirePosts(0), ["getSignaturesForAddress"]);
});
