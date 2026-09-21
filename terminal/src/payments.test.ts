import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
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
