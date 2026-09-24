import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { CHARGE_IX_DISC } from "./constants.js";
import {
  decodeEventsFromLogs,
  decisionsFromTx,
  encodePaidLog,
  encodeRefusedLog,
  linesForProgram,
} from "./events.js";
import type { TxView } from "./types.js";

const MANDATE = new PublicKey("CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g");
const DEST = "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F";
const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";

function framed(lines: readonly string[]): string[] {
  return [`Program ${PROGRAM} invoke [1]`, ...lines, `Program ${PROGRAM} success`];
}

test("decodes a Paid event from Program data", () => {
  const log = encodePaidLog({ mandate: MANDATE, amount: 446000n, nonce: 1789855200n, spent: 446000n });
  const events = decodeEventsFromLogs([log]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "paid");
  assert.equal(events[0]?.amount, 446000n);
  assert.equal(events[0]?.nonce, 1789855200n);
  assert.equal(events[0]?.mandate, MANDATE.toBase58());
  assert.equal(events[0]?.reason, 0);
  assert.equal(events[0]?.suggestedOverride, 0n);
});

test("decodes a Refused event including suggested override", () => {
  const log = encodeRefusedLog({
    mandate: MANDATE,
    amount: 519500n,
    nonce: 1789860600n,
    reason: 5,
    suggestedOverride: 519500n,
  });
  const events = decodeEventsFromLogs([log]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "refused");
  assert.equal(events[0]?.reason, 5);
  assert.equal(events[0]?.suggestedOverride, 519500n);
});

test("an unframed log carries no attributable decision", () => {
  const log = encodePaidLog({ mandate: MANDATE, amount: 446000n, nonce: 1n, spent: 446000n });
  assert.deepEqual(linesForProgram([log], PROGRAM), []);
  assert.deepEqual(decodeEventsFromLogs([log], PROGRAM), []);
  assert.deepEqual(linesForProgram(framed([log]), PROGRAM), [log]);
});

test("ignores logs that are not Paid or Refused events", () => {
  const events = decodeEventsFromLogs([
    "Program log: VETO OPENED cap=1",
    "Program data: AAAA",
  ]);
  assert.equal(events.length, 0);
});

test("does not invent entries when a transaction has no events", () => {
  const tx: TxView = {
    signature: "sig",
    slot: 1,
    blockTime: 10,
    err: null,
    logs: ["Program log: hello"],
    accountKeys: [PROGRAM],
    instructions: [],
  };
  assert.deepEqual(decisionsFromTx(tx, PROGRAM), []);
});

test("pulls counterparty from the charge destination account", () => {
  const log = encodePaidLog({ mandate: MANDATE, amount: 500n, nonce: 1n, spent: 500n });
  const data = Buffer.concat([CHARGE_IX_DISC, Buffer.alloc(16)]);
  const tx: TxView = {
    signature: "paidSig",
    slot: 9,
    blockTime: 100,
    err: null,
    logs: framed([log]),
    accountKeys: [],
    instructions: [
      {
        programId: PROGRAM,
        accounts: ["agent", MANDATE.toBase58(), "ledger", "source", DEST, "mint", "token"],
        data,
      },
    ],
  };
  const rows = decisionsFromTx(tx, PROGRAM);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.counterparty, DEST);
  assert.equal(rows[0]?.signature, "paidSig");
  assert.equal(rows[0]?.kind, "paid");
  assert.equal(rows[0]?.timestamp, 100);
});

test("filters by mandate and leaves other events out", () => {
  const other = new PublicKey("11111111111111111111111111111112");
  const paid = encodePaidLog({ mandate: MANDATE, amount: 1n, nonce: 1n, spent: 1n });
  const refused = encodeRefusedLog({
    mandate: other,
    amount: 2n,
    nonce: 2n,
    reason: 5,
    suggestedOverride: 2n,
  });
  const tx: TxView = {
    signature: "s",
    slot: 1,
    blockTime: 1,
    err: null,
    logs: framed([paid, refused]),
    accountKeys: [],
    instructions: [
      {
        programId: PROGRAM,
        accounts: ["a", MANDATE.toBase58(), "l", "s", DEST, "m", "t"],
        data: Buffer.concat([CHARGE_IX_DISC, Buffer.alloc(16)]),
      },
    ],
  };
  const rows = decisionsFromTx(tx, PROGRAM, MANDATE.toBase58());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "paid");
});

test("a charge with only a text log is still one decision", () => {
  const data = Buffer.concat([
    CHARGE_IX_DISC,
    Buffer.from(new Uint8Array(16)),
  ]);
  data.writeBigUInt64LE(446000n, 8);
  data.writeBigUInt64LE(7n, 16);
  const tx: TxView = {
    signature: "text-only",
    slot: 3,
    blockTime: 50,
    err: null,
    logs: framed(["Program log: VETO PAID amount=446000"]),
    accountKeys: [],
    instructions: [
      {
        programId: PROGRAM,
        accounts: ["agent", MANDATE.toBase58(), "ledger", "source", DEST, "mint", "token"],
        data,
      },
    ],
  };
  const rows = decisionsFromTx(tx, PROGRAM);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.signature, "text-only");
  assert.equal(rows[0]?.mandate, MANDATE.toBase58());
  assert.equal(rows[0]?.amount, 446000n);
  assert.equal(rows[0]?.nonce, 7n);
  assert.equal(rows[0]?.counterparty, DEST);
});

test("program data and a text log for the same charge count once", () => {
  const log = encodePaidLog({ mandate: MANDATE, amount: 500n, nonce: 1n, spent: 500n });
  const data = Buffer.concat([CHARGE_IX_DISC, Buffer.alloc(16)]);
  const tx: TxView = {
    signature: "both",
    slot: 4,
    blockTime: 60,
    err: null,
    logs: framed([log, "Program log: VETO PAID amount=500"]),
    accountKeys: [],
    instructions: [
      {
        programId: PROGRAM,
        accounts: ["agent", MANDATE.toBase58(), "ledger", "source", DEST, "mint", "token"],
        data,
      },
    ],
  };
  assert.equal(decisionsFromTx(tx, PROGRAM).length, 1);
});

test("idl event discriminators stay in lockstep with the encoder", () => {
  const idl = JSON.parse(readFileSync(new URL("../idl/veto.json", import.meta.url), "utf8")) as {
    events: { name: string; discriminator: number[] }[];
  };
  const paid = idl.events.find((e) => e.name === "Paid");
  const refused = idl.events.find((e) => e.name === "Refused");
  assert.deepEqual(paid?.discriminator, [240, 193, 17, 238, 238, 210, 129, 235]);
  assert.deepEqual(refused?.discriminator, [230, 49, 133, 208, 106, 62, 106, 169]);
});
