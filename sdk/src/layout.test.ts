import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { decodeLedger, decodeMandate, ledgerPda, mandatePda, u64Le } from "./layout.js";
import { ledgerBytes, mandateBytes, type MandateFields } from "./testkit.js";

const DEVNET = {
  owner: "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc",
  agent: "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w",
  mint: "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU",
  source: "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE",
  merchant: "6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG",
};

test("a mandate address is the PDA of mandate, owner, and the id as a little-endian u64", () => {
  const owner = Keypair.generate().publicKey;
  const id = 3n;
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(id);
  assert.deepEqual(u64Le(id), le);
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.toBuffer(), le],
    PROGRAM_ID,
  );
  assert.equal(mandatePda(PROGRAM_ID, owner, id).toBase58(), expected.toBase58());
});

test("a ledger address is the PDA of ledger and the mandate", () => {
  const mandate = Keypair.generate().publicKey;
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), mandate.toBuffer()],
    PROGRAM_ID,
  );
  assert.equal(ledgerPda(PROGRAM_ID, mandate).toBase58(), expected.toBase58());
});

test("decodeMandate reads the devnet mandate 3 account, including its stored source", () => {
  const raw = readFileSync(fileURLToPath(new URL("../fixtures/mandate-3.bin", import.meta.url)));
  const mandate = decodeMandate(raw);
  assert.equal(mandate.owner.toBase58(), DEVNET.owner);
  assert.equal(mandate.agent.toBase58(), DEVNET.agent);
  assert.equal(mandate.mint.toBase58(), DEVNET.mint);
  assert.equal(mandate.source.toBase58(), DEVNET.source);
  assert.equal(mandate.merchant.toBase58(), DEVNET.merchant);
  assert.equal(mandate.mandateId, 3n);
  assert.equal(mandate.cap, 300_000_000n);
  assert.equal(mandate.spent, 0n);
  assert.equal(mandate.perTxMax, 10_000_000n);
  assert.equal(mandate.expiresAt, 1_797_805_739n);
  assert.equal(mandate.lastNonce, 0n);
  assert.equal(mandate.purpose, "Charging top-ups at the SE3 spot rate");
  assert.equal(mandate.status, 0);
  assert.equal(mandate.spendCount, 0);
  assert.equal(mandate.refusalCount, 8);
  assert.equal(mandate.bump, 254);
});

test("decodeMandate rejects an account that is not a mandate", () => {
  const data = Buffer.alloc(310);
  assert.throws(() => decodeMandate(data), /Mandate account discriminator mismatch/);
});

test("decodeLedger returns all 32 ring slots with the written entry intact", () => {
  const mandate = Keypair.generate().publicKey;
  const counterparty = Keypair.generate().publicKey;
  const raw = ledgerBytes({
    mandate,
    total: 40,
    head: 8,
    bump: 3,
    entries: [
      {
        index: 31,
        ts: 50n,
        amount: 10_000_001n,
        counterparty,
        nonce: 9n,
        suggestedOverride: 10_000_001n,
        kind: 2,
        reason: 5,
      },
    ],
  });
  const ledger = decodeLedger(raw);
  assert.equal(ledger.entries.length, 32);
  assert.equal(ledger.mandate.toBase58(), mandate.toBase58());
  assert.equal(ledger.total, 40);
  assert.equal(ledger.head, 8);
  assert.equal(ledger.bump, 3);
  const last = ledger.entries[31];
  assert.ok(last);
  assert.equal(last.amount, 10_000_001n);
  assert.equal(last.nonce, 9n);
  assert.equal(last.reason, 5);
  assert.equal(last.kind, 2);
  assert.equal(last.suggestedOverride, 10_000_001n);
  assert.equal(last.counterparty.toBase58(), counterparty.toBase58());
  assert.equal(last.ts, 50n);
  const empty = ledger.entries[0];
  assert.ok(empty);
  assert.equal(empty.amount, 0n);
  assert.equal(empty.nonce, 0n);
});

test("a round-tripped mandate keeps the source that was written", () => {
  const fields: MandateFields = {
    owner: Keypair.generate().publicKey,
    agent: Keypair.generate().publicKey,
    mint: Keypair.generate().publicKey,
    source: Keypair.generate().publicKey,
    merchant: Keypair.generate().publicKey,
    mandateId: 3n,
    cap: 1n,
    spent: 2n,
    perTxMax: 3n,
    expiresAt: -4n,
    overrideAmount: 5n,
    overrideNonce: 6n,
    lastNonce: 7n,
    purpose: "groceries",
    status: 1,
    spendCount: 8,
    refusalCount: 9,
    bump: 10,
  };
  const decoded = decodeMandate(mandateBytes(fields));
  assert.equal(decoded.source.toBase58(), fields.source.toBase58());
  assert.equal(decoded.lastNonce, 7n);
  assert.equal(decoded.expiresAt, -4n);
  assert.equal(decoded.purpose, "groceries");
  assert.equal(decoded.refusalCount, 9);
});
