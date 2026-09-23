// Issue 135. A runtime "Log truncated" line is not an empty decision list.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { CHARGE_IX_DISC } from "./constants.js";
import { decisionsFromTx } from "./events.js";
import type { TxView } from "./types.js";

const PROGRAM = "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV";
const MANDATE = new PublicKey("CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g");

function view(logs: string[]): TxView {
  const data = Buffer.concat([CHARGE_IX_DISC, Buffer.alloc(16)]);
  data.writeBigUInt64LE(300_000n, 8);
  data.writeBigUInt64LE(2n, 16);
  return {
    signature: "sig-truncated",
    slot: 4,
    blockTime: 1_790_200_000,
    err: null,
    logs,
    accountKeys: [PROGRAM, MANDATE.toBase58()],
    instructions: [
      {
        programId: PROGRAM,
        accounts: ["agent", MANDATE.toBase58(), "ledger", "source", "dest", "mint", "token"],
        data,
      },
    ],
  };
}

test("a bare Log truncated line is an explicit truncation, not an empty decision list", () => {
  const rows = decisionsFromTx(
    view([`Program ${PROGRAM} invoke [1]`, "Program log: " + "x".repeat(40), "Log truncated"]),
    PROGRAM,
  );
  assert.deepEqual(rows, []);
  assert.equal((rows as { truncated?: boolean }).truncated, true);
});

test("a program log that merely spells Log truncated is not the runtime cut", () => {
  const rows = decisionsFromTx(view(["Program log: Log truncated"]), PROGRAM);
  assert.equal((rows as { truncated?: boolean }).truncated, undefined);
});
