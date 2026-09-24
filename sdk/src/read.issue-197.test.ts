import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, framed, legacyChargeTx, paidLog, world, type FakeConnection } from "./testkit.js";

function putPaid(
  fake: FakeConnection,
  w: ReturnType<typeof world>,
  signature: string,
  slot: number,
  blockTime: number,
  nonce: bigint,
): void {
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  const amount = nonce;
  fake.transactions.set(
    signature,
    legacyChargeTx({
      signature,
      slot,
      blockTime,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)]),
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

function listed(signature: string, slot: number, blockTime: number): ConfirmedSignatureInfo {
  return {
    signature,
    slot,
    err: null,
    memo: null,
    blockTime,
    confirmationStatus: "confirmed",
  };
}

test("decisionsForMandate reads one signature page and does not open older pages", async () => {
  const w = world();
  putPaid(w.fake, w, "newest", 30, 300, 3n);
  putPaid(w.fake, w, "middle", 20, 200, 2n);
  putPaid(w.fake, w, "oldest", 10, 100, 1n);
  w.fake.signatures = [listed("newest", 30, 300), listed("middle", 20, 200), listed("oldest", 10, 100)];
  const rows = await decisionsForMandate(w.connection, w.mandate, { pageSize: 1 });
  assert.deepEqual(
    rows.map((row) => row.signature),
    ["newest"],
  );
  assert.deepEqual(w.fake.opened, ["newest"]);
  assert.equal(w.fake.signatureQueries.length, 1);
});

test("decisionsForMandate does not open a second page when the mandate has more than one page of signatures", async () => {
  const w = world();
  const rows: ConfirmedSignatureInfo[] = [];
  for (let i = 0; i < 1001; i += 1) {
    rows.push(listed(`s${i}`, 5000 - i, 5000 - i));
  }
  w.fake.signatures = rows;
  await decisionsForMandate(w.connection, w.mandate);
  assert.equal(w.fake.signatureQueries.length, 1);
  assert.equal(w.fake.opened.length, 1000);
  assert.equal(w.fake.opened.includes("s1000"), false);
});

test("decisionsForMandate returns the newest limit decisions and does not open the rest", async () => {
  const w = world();
  putPaid(w.fake, w, "newest", 30, 300, 3n);
  putPaid(w.fake, w, "middle", 20, 200, 2n);
  putPaid(w.fake, w, "oldest", 10, 100, 1n);
  w.fake.signatures = [listed("newest", 30, 300), listed("middle", 20, 200), listed("oldest", 10, 100)];
  const rows = await decisionsForMandate(w.connection, w.mandate, { limit: 1 });
  assert.deepEqual(
    rows.map((row) => row.signature),
    ["newest"],
  );
  assert.deepEqual(w.fake.opened, ["newest"]);
});

test("decisionsForMandate starts after a before cursor and does not return that signature", async () => {
  const w = world();
  putPaid(w.fake, w, "newest", 30, 300, 3n);
  putPaid(w.fake, w, "middle", 20, 200, 2n);
  putPaid(w.fake, w, "oldest", 10, 100, 1n);
  w.fake.signatures = [listed("newest", 30, 300), listed("middle", 20, 200), listed("oldest", 10, 100)];
  const rows = await decisionsForMandate(w.connection, w.mandate, { before: "middle" });
  assert.deepEqual(
    rows.map((row) => row.signature),
    ["oldest"],
  );
});

test("decisionsForMandate stops at an until cursor and does not return that signature", async () => {
  const w = world();
  putPaid(w.fake, w, "newest", 30, 300, 3n);
  putPaid(w.fake, w, "middle", 20, 200, 2n);
  putPaid(w.fake, w, "oldest", 10, 100, 1n);
  w.fake.signatures = [listed("newest", 30, 300), listed("middle", 20, 200), listed("oldest", 10, 100)];
  const rows = await decisionsForMandate(w.connection, w.mandate, { until: "middle" });
  assert.deepEqual(
    rows.map((row) => row.signature),
    ["newest"],
  );
});

test("decisionsForMandate rejects a limit that is not a positive integer within one page", async () => {
  const w = world();
  await assert.rejects(
    () => decisionsForMandate(w.connection, w.mandate, { limit: 0 }),
    /limit must be an integer from 1 to 1000/,
  );
});
