// Security critic fixtures, PR 195 round 2.
// T1: the round 1 fix picks the merchant ATA on any getAccountInfo hit
// (agent.ts:273). A system transfer to the not-yet-created ATA address leaves a
// system-owned, zero-data account there, and charge() then names it as the
// destination. The program will not deserialise it (lib.rs:513), so the
// transaction fails and no paid result can come of it; a merchant with only an
// auxiliary token account is blocked until someone creates the ATA. Marked todo:
// red on 831fd40, closes with an owner check on the ATA hit.
// T2: one agent, two charges in one transaction. The paid one is on the agent's
// other mandate and carries its event; the refused one is on V and its event is
// cut. Neither read path reports paid for V.
// T3: a Veto-owned account with the Ledger discriminator at the mandate address
// is not a mandate on any surface.
import assert from "node:assert/strict";
import test from "node:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { decisionsFromTx, viewFromRpc, type RpcTransaction } from "./events.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda, mandatePda } from "./layout.js";
import { decisionsForMandate, fetchMandate } from "./read.js";
import {
  TOKEN_PROGRAM,
  chargeData,
  encodeBase58,
  ledgerBytes,
  legacyChargeTx,
  paidLog,
  world,
} from "./testkit.js";

const PROGRAM = PROGRAM_ID.toBase58();

type W = ReturnType<typeof world>;

function chargeKeys(w: W): PublicKey[] {
  return [
    w.agent.publicKey,
    w.mandate,
    ledgerPda(PROGRAM_ID, w.mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM,
    PROGRAM_ID,
  ];
}

test(
  "T1 a system-owned account at the merchant ATA address is not sent as the destination",
  { todo: "red on 831fd40: agent.ts:273 returns the ATA on any account hit without an owner check" },
  async () => {
    const w = world();
    const ata = getAssociatedTokenAddressSync(w.mint.publicKey, w.merchant.publicKey, true, TOKEN_PROGRAM);
    // A stranger's SystemProgram.transfer to the ATA address before anyone creates it:
    // rent-exempt minimum for zero bytes, owned by the system program, no data.
    w.fake.accounts.set(ata.toBase58(), { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 890_880 });
    // The merchant's one real token account is the auxiliary one world() lists.
    w.fake.signature = "sig-t1";
    w.fake.transactions.set(
      "sig-t1",
      legacyChargeTx({
        signature: "sig-t1",
        slot: 7,
        blockTime: 1_790_400_000,
        logs: [`Program ${PROGRAM} invoke [1]`, paidLog(w.mandate, 1n, 1n, 1n), `Program ${PROGRAM} success`],
        keys: chargeKeys(w),
        amount: 1n,
        nonce: 1n,
      }),
    );
    const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
    await veto.charge({ amount: 1n, nonce: 1n }).catch(() => undefined);
    const sent = w.fake.sent[0];
    assert.ok(sent, "nothing was sent");
    assert.ok(
      !sent.includes(ata.toBuffer()),
      "charge named the system-owned account at the ATA address as the destination",
    );
    assert.ok(sent.includes(w.destination.publicKey.toBuffer()), "the merchant token account was not the destination");
  },
);

test("T2 a paid event on the agent's other mandate never becomes a paid row for the refused charge on V", async () => {
  const w = world({ spent: 300_000_000n });
  const mandateB = mandatePda(PROGRAM_ID, w.owner.publicKey, 4n);
  const sourceB = Keypair.generate().publicKey;
  const keys = [...chargeKeys(w), mandateB, ledgerPda(PROGRAM_ID, mandateB), sourceB];
  const k = keys.map((key) => key.toBase58());
  // First charge: mandate B, paid, event present. Second charge: V, refused over
  // cap, the budget runs out after the REFUSED msg! and before the emit!.
  const logs = [
    `Program ${PROGRAM} invoke [1]`,
    "Program log: Instruction: Charge",
    `Program ${TOKEN_PROGRAM.toBase58()} invoke [2]`,
    "Program log: Instruction: TransferChecked",
    `Program ${TOKEN_PROGRAM.toBase58()} success`,
    "Program log: VETO PAID amount=100 spent=100 of cap=300000000 remaining=299999900",
    paidLog(mandateB, 100n, 5n, 100n),
    `Program ${PROGRAM} success`,
    `Program ${PROGRAM} invoke [1]`,
    "Program log: Instruction: Charge",
    "Program log: VETO REFUSED reason=6 (over cap) amount=100 per_tx_max=10000000 remaining=0 override_to_clear=0",
    "Log truncated",
  ];
  const tx: RpcTransaction = {
    slot: 910,
    blockTime: 1_790_400_100,
    meta: { err: null, logMessages: logs },
    transaction: {
      signatures: ["sig-t2"],
      message: {
        accountKeys: k,
        instructions: [
          { programIdIndex: k.indexOf(PROGRAM), accounts: [0, 8, 9, 10, 4, 5, 6], data: encodeBase58(chargeData(100n, 5n)) },
          { programIdIndex: k.indexOf(PROGRAM), accounts: [0, 1, 2, 3, 4, 5, 6], data: encodeBase58(chargeData(100n, 5n)) },
        ],
      },
    },
  };
  const direct = decisionsFromTx(viewFromRpc(tx, { signature: "sig-t2", slot: 910 }), PROGRAM, w.mandate.toBase58());
  assert.deepEqual(direct, []);
  const unfiltered = decisionsFromTx(viewFromRpc(tx, { signature: "sig-t2", slot: 910 }), PROGRAM);
  assert.deepEqual(unfiltered.map((row) => [row.kind, row.mandate]), [["paid", mandateB.toBase58()]]);
  w.fake.signatures = [{ signature: "sig-t2", slot: 910, err: null, blockTime: 1_790_400_100, memo: null }];
  w.fake.transactions.set("sig-t2", tx);
  assert.deepEqual(await decisionsForMandate(w.connection, w.mandate), []);
  // charge() on V confirmed by this transaction: no decision, never paid.
  w.fake.signature = "sig-t2";
  await assert.rejects(
    new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate }).charge({ amount: 100n, nonce: 5n }),
    /no attributable Veto decision/,
  );
});

test("T3 a Veto-owned account with the Ledger discriminator at the mandate address is not a mandate", async () => {
  const w = world();
  w.fake.accounts.set(w.mandate.toBase58(), {
    data: ledgerBytes({ mandate: w.mandate, total: 0, head: 0, bump: 1 }),
    owner: PROGRAM_ID,
    lamports: 1,
  });
  await assert.rejects(fetchMandate(w.connection, w.mandate), /discriminator/);
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  await assert.rejects(veto.status(), /discriminator/);
  await assert.rejects(veto.charge({ amount: 1n, nonce: 1n }), /discriminator/);
  assert.equal(w.fake.sent.length, 0);
});
