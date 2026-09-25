import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import {
  MANDATE_AGENT_OFFSET,
  TRADE_ENTRY_SIZE,
  TRADE_LEDGER_CAPACITY,
  TRADE_RULE_AGENT_OFFSET,
  decodeLedger,
  decodeMandate,
  decodeTradeLedger,
  decodeTradeRule,
  ledgerPda,
  mandatePda,
  tradeLedgerPda,
  tradeRulePda,
  u64Le,
} from "./layout.js";
import { ledgerBytes, mandateBytes, tradeLedgerBytes, tradeRuleBytes, tradeWorld, type MandateFields } from "./testkit.js";

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

test("the agent pubkey is stored at MANDATE_AGENT_OFFSET", () => {
  const raw = readFileSync(fileURLToPath(new URL("../fixtures/mandate-3.bin", import.meta.url)));
  const slice = raw.subarray(MANDATE_AGENT_OFFSET, MANDATE_AGENT_OFFSET + 32);
  assert.equal(new PublicKey(slice).toBase58(), DEVNET.agent);
  assert.equal(decodeMandate(raw).agent.toBase58(), DEVNET.agent);
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

test("a trade rule address is the PDA of trade, owner, and the id as a little-endian u64", () => {
  const owner = Keypair.generate().publicKey;
  const id = 7n;
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("trade"), owner.toBuffer(), u64Le(id)],
    PROGRAM_ID,
  );
  assert.equal(tradeRulePda(PROGRAM_ID, owner, id).toBase58(), expected.toBase58());
});

test("a trade ledger address is the PDA of trade-ledger and the rule", () => {
  const rule = Keypair.generate().publicKey;
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("trade-ledger"), rule.toBuffer()],
    PROGRAM_ID,
  );
  assert.equal(tradeLedgerPda(PROGRAM_ID, rule).toBase58(), expected.toBase58());
});

test("tradeRuleBytes is the on-chain layout, including the packed pool pubkey", () => {
  const fields = tradeWorld({ dailyBuckets: Array.from({ length: 25 }, (_, i) => ({
    hour: BigInt(500_000 + i), amount: BigInt(i + 1),
  })) }).fields;
  const raw = tradeRuleBytes(fields);
  const agent = raw.subarray(TRADE_RULE_AGENT_OFFSET, TRADE_RULE_AGENT_OFFSET + 32);
  assert.equal(new PublicKey(agent).toBase58(), fields.agent.toBase58());
  assert.equal(raw[232], fields.exchangeKind);
  assert.equal(new PublicKey(raw.subarray(233, 265)).toBase58(), fields.pool.toBase58());
  const decoded = decodeTradeRule(raw);
  assert.equal(decoded.destination.toBase58(), fields.destination.toBase58());
  assert.equal(decoded.source.toBase58(), fields.source.toBase58());
  assert.equal(decoded.inMint.toBase58(), fields.inMint.toBase58());
  assert.equal(decoded.outMint.toBase58(), fields.outMint.toBase58());
  assert.equal(decoded.poolFeeAccount.toBase58(), fields.poolFeeAccount.toBase58());
  assert.equal(decoded.cap, fields.cap);
  assert.equal(decoded.perTradeMax, fields.perTradeMax);
  assert.equal(decoded.dailyLimit, fields.dailyLimit);
  assert.equal(decoded.floorNum, fields.floorNum);
  assert.equal(decoded.floorDen, fields.floorDen);
  assert.deepEqual(decoded.dailyBuckets, fields.dailyBuckets);
  assert.equal(decoded.expiresAt, fields.expiresAt);
  assert.equal(decoded.purpose, fields.purpose);
  assert.equal(decoded.lastNonce, fields.lastNonce);
  assert.equal(decoded.bump, fields.bump);
});

test("a trade ledger that has not wrapped reads the written entries oldest first", () => {
  const rule = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const raw = tradeLedgerBytes({
    rule,
    total: 2,
    head: 2,
    bump: 4,
    entries: [
      {
        index: 0,
        ts: 10n,
        amountIn: 4n,
        amountOut: 7n,
        minOut: 6n,
        counterparty: pool,
        nonce: 4n,
        suggestedOverride: 0n,
        kind: 1,
        reason: 0,
      },
      {
        index: 1,
        ts: 11n,
        amountIn: 5n,
        amountOut: 0n,
        minOut: 9n,
        counterparty: pool,
        nonce: 5n,
        suggestedOverride: 5n,
        kind: 2,
        reason: 14,
      },
    ],
  });
  const ledger = decodeTradeLedger(raw);
  assert.equal(ledger.rule.toBase58(), rule.toBase58());
  assert.equal(ledger.total, 2);
  assert.equal(ledger.head, 2);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries[0]?.nonce, 4n);
  assert.equal(ledger.entries[0]?.amountOut, 7n);
  assert.equal(ledger.entries[1]?.nonce, 5n);
  assert.equal(ledger.entries[1]?.reason, 14);
  assert.equal(ledger.entries[1]?.suggestedOverride, 5n);
});

test("a wrapped trade ledger is read oldest first", () => {
  const rule = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const entries = [];
  for (let i = 0; i < TRADE_LEDGER_CAPACITY; i += 1) {
    entries.push({
      index: i,
      ts: BigInt(1_000 + i),
      amountIn: BigInt(i + 1),
      amountOut: BigInt((i + 1) * 2),
      minOut: 1n,
      counterparty: pool,
      nonce: BigInt(i + 1),
      suggestedOverride: 0n,
      kind: 1,
      reason: 0,
    });
  }
  const raw = tradeLedgerBytes({ rule, total: 40, head: 8, bump: 2, entries });
  assert.equal(raw.length, 8 + 40 + TRADE_LEDGER_CAPACITY * TRADE_ENTRY_SIZE);
  const ledger = decodeTradeLedger(raw);
  assert.equal(ledger.entries.length, 32);
  assert.equal(ledger.head, 8);
  assert.equal(ledger.total, 40);
  assert.equal(ledger.entries[0]?.nonce, 9n);
  assert.equal(ledger.entries[0]?.ts, 1_008n);
  assert.equal(ledger.entries[0]?.amountIn, 9n);
  assert.equal(ledger.entries[23]?.nonce, 32n);
  assert.equal(ledger.entries[24]?.nonce, 1n);
  assert.equal(ledger.entries[31]?.nonce, 8n);
  assert.equal(ledger.entries[31]?.amountOut, 16n);
  assert.equal(ledger.entries[31]?.counterparty.toBase58(), pool.toBase58());
});
