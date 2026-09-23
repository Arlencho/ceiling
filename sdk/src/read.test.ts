import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate, fetchLedger, fetchMandate } from "./read.js";
import {
  TOKEN_PROGRAM,
  asConnection,
  framed,
  ledgerBytes,
  legacyChargeTx,
  paidLog,
  world,
  type FakeConnection,
} from "./testkit.js";

test("fetchMandate reads the account the caller names", async () => {
  const w = world({ lastNonce: 4n, perTxMax: 10n });
  const mandate = await fetchMandate(w.connection, w.mandate);
  assert.equal(mandate.source.toBase58(), w.source.publicKey.toBase58());
  assert.equal(mandate.lastNonce, 4n);
  assert.equal(mandate.perTxMax, 10n);
  assert.equal(mandate.mandateId, 3n);
});

test("fetchMandate throws when the account is missing", async () => {
  const w = world();
  const missing = Keypair.generate().publicKey;
  await assert.rejects(() => fetchMandate(w.connection, missing), /account not found/);
});

test("fetchLedger decodes the 32-entry ring", async () => {
  const w = world();
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.accounts.set(ledger.toBase58(), {
    data: ledgerBytes({
      mandate: w.mandate,
      total: 1,
      head: 1,
      bump: 2,
      entries: [
        {
          index: 0,
          ts: 9n,
          amount: 15n,
          counterparty: w.destination.publicKey,
          nonce: 3n,
          suggestedOverride: 0n,
          kind: 1,
          reason: 0,
        },
      ],
    }),
    owner: PROGRAM_ID,
    lamports: 1,
  });
  const decoded = await fetchLedger(w.connection, ledger);
  assert.equal(decoded.entries.length, 32);
  assert.equal(decoded.total, 1);
  assert.equal(decoded.head, 1);
  assert.equal(decoded.entries[0]?.amount, 15n);
  assert.equal(decoded.entries[0]?.counterparty.toBase58(), w.destination.publicKey.toBase58());
  assert.equal(decoded.entries[31]?.amount, 0n);
});

function putCharge(
  fake: FakeConnection,
  w: ReturnType<typeof world>,
  signature: string,
  slot: number,
  blockTime: number,
  logs: string[],
  amount: bigint,
  nonce: bigint,
  err: unknown = null,
): void {
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  fake.transactions.set(
    signature,
    legacyChargeTx({
      signature,
      slot,
      blockTime,
      err,
      logs,
      amount,
      nonce,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledger,
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
}

test("decisionsForMandate pages signatures and keeps only attributable Veto decisions", async () => {
  const w = world();
  putCharge(
    w.fake,
    w,
    "older",
    10,
    100,
    framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, 8n, 1n, 8n)]),
    8n,
    1n,
  );
  putCharge(
    w.fake,
    w,
    "newer",
    20,
    200,
    [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      `Program ${TOKEN_PROGRAM.toBase58()} invoke [2]`,
      paidLog(w.mandate, 9n, 2n, 9n),
      `Program ${TOKEN_PROGRAM.toBase58()} success`,
      `Program ${PROGRAM_ID.toBase58()} success`,
    ],
    9n,
    2n,
  );
  w.fake.signatures = [
    { signature: "newer", slot: 20, err: null, memo: null, blockTime: 200, confirmationStatus: "confirmed" },
    { signature: "do-not-fetch", slot: 15, err: { InstructionError: [0, "Custom"] }, memo: null, blockTime: 150, confirmationStatus: "confirmed" },
    { signature: "older", slot: 10, err: null, memo: null, blockTime: 100, confirmationStatus: "confirmed" },
  ];
  const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.signature, "older");
  assert.equal(rows[0]?.kind, "paid");
  assert.equal(rows[0]?.amount, 8n);
  assert.equal(rows[0]?.nonce, 1n);
  assert.equal(rows[0]?.counterparty, w.destination.publicKey.toBase58());
  assert.equal(rows[0]?.reasonText, "ok");
  assert.deepEqual(
    w.fake.signatureQueries.map((query) => query.before ?? ""),
    ["", "newer", "do-not-fetch", "older"],
  );
});

test("decisionsForMandate can be called without a keypair", async () => {
  const w = world();
  const rows = await decisionsForMandate(asConnection(w.fake), w.mandate.toBase58());
  assert.deepEqual(rows, []);
});
