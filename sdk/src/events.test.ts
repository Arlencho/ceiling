import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { decisionsFromTx, tradeDecisionsFromTx, type TxView } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import { TOKEN_PROGRAM, chargeData, framed, paidLog, refusedLog, tradeRefusedLog, tradedLog } from "./testkit.js";

const PROGRAM = PROGRAM_ID.toBase58();

function view(partial: Partial<TxView> & Pick<TxView, "logs" | "instructions">): TxView {
  return {
    signature: partial.signature ?? "sig",
    slot: partial.slot ?? 7,
    blockTime: partial.blockTime ?? 100,
    err: partial.err ?? null,
    logs: partial.logs,
    accountKeys: partial.accountKeys ?? [],
    instructions: partial.instructions,
  };
}

function chargeIx(mandate: string, destination: string, amount: bigint, nonce: bigint) {
  return {
    programId: PROGRAM,
    accounts: ["agent", mandate, "ledger", "source", destination, "mint", TOKEN_PROGRAM.toBase58()],
    data: chargeData(amount, nonce),
  };
}

test("a Paid event inside the Veto frame is one paid decision", () => {
  const mandate = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey.toBase58();
  const rows = decisionsFromTx(
    view({
      logs: framed(PROGRAM, [paidLog(mandate, 500n, 4n, 500n), "Program log: VETO PAID amount=500"]),
      instructions: [chargeIx(mandate.toBase58(), destination, 500n, 4n)],
    }),
    PROGRAM,
    mandate.toBase58(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "paid");
  assert.equal(rows[0]?.reason, 0);
  assert.equal(rows[0]?.reasonText, "ok");
  assert.equal(rows[0]?.suggestedOverride, 0n);
  assert.equal(rows[0]?.amount, 500n);
  assert.equal(rows[0]?.nonce, 4n);
  assert.equal(rows[0]?.counterparty, destination);
  assert.equal(rows[0]?.slot, 7);
});

test("a Refused event keeps the reason code and the suggested override", () => {
  const mandate = Keypair.generate().publicKey;
  const rows = decisionsFromTx(
    view({
      logs: framed(PROGRAM, [refusedLog(mandate, 10_000_001n, 1n, 5, 10_000_001n)]),
      instructions: [chargeIx(mandate.toBase58(), "dest", 10_000_001n, 1n)],
    }),
    PROGRAM,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "refused");
  assert.equal(rows[0]?.reason, 5);
  assert.equal(rows[0]?.reasonText, "over per-payment maximum");
  assert.equal(rows[0]?.suggestedOverride, 10_000_001n);
});

test("program data inside a sibling invoke is not a Veto decision", () => {
  const mandate = Keypair.generate().publicKey;
  const logs = [
    `Program ${PROGRAM} invoke [1]`,
    `Program ${TOKEN_PROGRAM.toBase58()} invoke [2]`,
    paidLog(mandate, 1n, 1n, 1n),
    `Program ${TOKEN_PROGRAM.toBase58()} success`,
    `Program ${PROGRAM} success`,
  ];
  const rows = decisionsFromTx(
    view({ logs, instructions: [chargeIx(mandate.toBase58(), "dest", 1n, 1n)] }),
    PROGRAM,
    mandate.toBase58(),
  );
  assert.deepEqual(rows, []);
});

test("a text line without a Program data event is not a decision", () => {
  const mandate = Keypair.generate().publicKey;
  const logs = framed(PROGRAM, [
    "Program log: VETO REFUSED reason=5 (nope) amount=10 override_to_clear=10",
  ]);
  const rows = decisionsFromTx(
    view({ logs, instructions: [chargeIx(mandate.toBase58(), "dest", 10n, 3n)] }),
    PROGRAM,
  );
  assert.deepEqual(rows, []);
});

test("a text line whose amount disagrees with the charge instruction is not a decision", () => {
  const mandate = Keypair.generate().publicKey;
  const rows = decisionsFromTx(
    view({
      logs: framed(PROGRAM, ["Program log: VETO PAID amount=10"]),
      instructions: [chargeIx(mandate.toBase58(), "dest", 11n, 3n)],
    }),
    PROGRAM,
  );
  assert.deepEqual(rows, []);
});

test("an event for another mandate does not fall back to a text line", () => {
  const mandate = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const rows = decisionsFromTx(
    view({
      logs: framed(PROGRAM, [
        paidLog(other, 1n, 1n, 1n),
        "Program log: VETO PAID amount=10",
      ]),
      instructions: [chargeIx(mandate.toBase58(), "dest", 10n, 2n)],
    }),
    PROGRAM,
    mandate.toBase58(),
  );
  assert.deepEqual(rows, []);
});

test("a failed transaction yields no decision", () => {
  const mandate = Keypair.generate().publicKey;
  const rows = decisionsFromTx(
    view({
      err: { InstructionError: [0, "Custom"] },
      logs: framed(PROGRAM, [paidLog(mandate, 1n, 1n, 1n)]),
      instructions: [chargeIx(mandate.toBase58(), "dest", 1n, 1n)],
    }),
    PROGRAM,
  );
  assert.deepEqual(rows, []);
});

test("an unframed Program data line still decodes", () => {
  const mandate = Keypair.generate().publicKey;
  const rows = decisionsFromTx(
    view({
      logs: [paidLog(mandate, 8n, 2n, 8n)],
      instructions: [chargeIx(mandate.toBase58(), "dest", 8n, 2n)],
    }),
    PROGRAM,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.amount, 8n);
  assert.equal(rows[0]?.nonce, 2n);
});

test("a Traded event is not a charge decision", () => {
  const rule = Keypair.generate().publicKey;
  const rows = decisionsFromTx(
    view({
      logs: framed(PROGRAM, [tradedLog(rule, 500n, 400n, 4n, 500n)]),
      instructions: [chargeIx(rule.toBase58(), "dest", 500n, 4n)],
    }),
    PROGRAM,
  );
  assert.equal(rows.length, 0);
});

test("a Traded event reports the output that came back", () => {
  const rule = Keypair.generate().publicKey;
  const rows = tradeDecisionsFromTx(
    view({
      logs: framed(PROGRAM, [tradedLog(rule, 500n, 400n, 4n, 500n)]),
      instructions: [],
    }),
    PROGRAM,
    rule.toBase58(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "traded");
  assert.equal(rows[0]?.amountIn, 500n);
  assert.equal(rows[0]?.amountOut, 400n);
  assert.equal(rows[0]?.nonce, 4n);
  assert.equal(rows[0]?.reason, 0);
  assert.equal(rows[0]?.reasonText, "ok");
  assert.equal(rows[0]?.suggestedOverride, 0n);
});

test("a TradeRefused event keeps the reason and leaves amountOut at zero", () => {
  const rule = Keypair.generate().publicKey;
  const rows = tradeDecisionsFromTx(
    view({
      logs: framed(PROGRAM, [tradeRefusedLog(rule, 10_000n, 9_000n, 2n, 14, 0n)]),
      instructions: [],
    }),
    PROGRAM,
    rule.toBase58(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "refused");
  assert.equal(rows[0]?.amountIn, 10_000n);
  assert.equal(rows[0]?.amountOut, 0n);
  assert.equal(rows[0]?.minOut, 9_000n);
  assert.equal(rows[0]?.reason, 14);
  assert.equal(rows[0]?.reasonText, "quote below floor");
  assert.equal(rows[0]?.suggestedOverride, 0n);
});

test("program data inside a sibling invoke is not a Veto trade decision", () => {
  const rule = Keypair.generate().publicKey;
  const logs = [
    `Program ${PROGRAM} invoke [1]`,
    `Program ${TOKEN_PROGRAM.toBase58()} invoke [2]`,
    tradedLog(rule, 1n, 1n, 1n, 1n),
    `Program ${TOKEN_PROGRAM.toBase58()} success`,
    tradeRefusedLog(rule, 1n, 1n, 1n, 12, 0n),
    `Program ${PROGRAM} success`,
  ];
  const rows = tradeDecisionsFromTx(view({ logs, instructions: [] }), PROGRAM, rule.toBase58());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "refused");
  assert.equal(rows[0]?.reason, 12);
  assert.equal(rows[0]?.reasonText, "pool not allowed");
});
