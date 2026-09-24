import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import type { RpcTransaction } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, chargeData, encodeBase58, framed, legacyChargeTx, paidLog, world, type FakeConnection } from "./testkit.js";

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

function listed(
  signature: string,
  slot: number,
  blockTime: number,
  err: ConfirmedSignatureInfo["err"] = null,
): ConfirmedSignatureInfo {
  return {
    signature,
    slot,
    err,
    memo: null,
    blockTime,
    confirmationStatus: "confirmed",
  };
}

function putTwoCharges(
  fake: FakeConnection,
  w: ReturnType<typeof world>,
  signature: string,
  slot: number,
  blockTime: number,
  first: bigint,
  second: bigint,
): void {
  const keys = [
    w.agent.publicKey,
    w.mandate,
    ledgerPda(PROGRAM_ID, w.mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM,
    PROGRAM_ID,
  ].map((key) => key.toBase58());
  const program = PROGRAM_ID.toBase58();
  const tx: RpcTransaction = {
    slot,
    blockTime,
    meta: {
      err: null,
      logMessages: [
        ...framed(program, [paidLog(w.mandate, first, first, first)]),
        ...framed(program, [paidLog(w.mandate, second, second, first + second)]),
      ],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        instructions: [
          { programIdIndex: keys.indexOf(program), accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(first, first)) },
          { programIdIndex: keys.indexOf(program), accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(second, second)) },
        ],
      },
    },
  };
  fake.transactions.set(signature, tx);
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
    const signature = `s${i}`;
    rows.push(listed(signature, 5000 - i, 5000 - i));
    w.fake.transactions.set(signature, {
      slot: 5000 - i,
      blockTime: 5000 - i,
      meta: { err: null, logMessages: [] },
      transaction: { signatures: [signature], message: { accountKeys: [], instructions: [] } },
    });
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

test("a limit that lands inside a two-charge transaction returns both decisions and does not open the next signature", async () => {
  const w = world();
  putTwoCharges(w.fake, w, "twin", 30, 300, 3n, 4n);
  putPaid(w.fake, w, "older", 10, 100, 1n);
  w.fake.signatures = [listed("twin", 30, 300), listed("older", 10, 100)];
  const rows = await decisionsForMandate(w.connection, w.mandate, { limit: 1 });
  assert.deepEqual(
    rows.map((row) => row.nonce),
    [3n, 4n],
  );
  assert.deepEqual(w.fake.opened, ["twin"]);
  assert.equal(rows.oldestSignature, "older");
  assert.equal(rows.pageFull, false);
});

test("a full page of failed signatures returns the listing cursor and no decisions", async () => {
  const w = world();
  putPaid(w.fake, w, "old", 10, 100, 1n);
  w.fake.signatures = [
    listed("fail-a", 40, 400, { InstructionError: [0, "Custom"] }),
    listed("fail-b", 30, 300, { InstructionError: [0, "Custom"] }),
    listed("old", 10, 100),
  ];
  const page = await decisionsForMandate(w.connection, w.mandate, { pageSize: 2 });
  assert.equal(page.length, 0);
  assert.equal(page.pageFull, true);
  assert.equal(page.oldestSignature, "fail-b");
  assert.deepEqual(w.fake.opened, []);
  const rest = await decisionsForMandate(w.connection, w.mandate, { pageSize: 2, before: page.oldestSignature ?? undefined });
  assert.deepEqual(
    rest.map((row) => row.signature),
    ["old"],
  );
  assert.equal(rest.pageFull, false);
});

test("the sdk README walks decisions from the listing cursor until the page is not full", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.match(readme, /oldestSignature/);
  assert.match(readme, /pageFull/);
  assert.match(readme, /Stop when a page is not full/);
  assert.match(readme, /never splits a transaction/);
  assert.match(readme, /ordered oldest first/);
});
