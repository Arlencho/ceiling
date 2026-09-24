import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate, MissingListedTransactionError } from "./read.js";
import { TOKEN_PROGRAM, framed, legacyChargeTx, paidLog, world } from "./testkit.js";

function listed(signature: string, slot: number): ConfirmedSignatureInfo {
  return { signature, slot, err: null, memo: null, blockTime: slot * 10, confirmationStatus: "confirmed" };
}

test("a listed signature whose getTransaction returns null is an error and the page is not shortened", async () => {
  const w = world();
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  w.fake.transactions.set(
    "newer",
    legacyChargeTx({
      signature: "newer",
      slot: 20,
      blockTime: 200,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, 2n, 2n, 2n)]),
      amount: 2n,
      nonce: 2n,
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
  w.fake.signatures = [listed("newer", 20), listed("older", 10)];

  await assert.rejects(
    () => decisionsForMandate(w.connection, w.mandate),
    (err: unknown) => {
      assert.ok(err instanceof MissingListedTransactionError);
      assert.equal(err.signature, "older");
      assert.match(err.message, /older/);
      return true;
    },
  );
  assert.deepEqual(w.fake.opened, ["newer", "older"]);
});
