// Issue 208. The indexer path must not treat a ledger transport error, or a
// missing ledger on a live mandate, as an empty ring.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TransportError, isTransportError } from "../indexer/src/rpc.js";
import type { IndexedDecision } from "./bulk.js";
import { recordsFromIndexedDecisions } from "./export.js";
import {
  CHARGE_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  ledgerPda,
  mandatePda,
  u64Le,
} from "./lib.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
const SOURCE = new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const SIG = "live-charge";

function encodeMandate(mandateId: bigint): Buffer {
  const purpose = Buffer.from("live rule", "utf8");
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const key of [OWNER, AGENT, MINT, SOURCE, MERCHANT]) {
    key.toBuffer().copy(buf, o);
    o += 32;
  }
  for (const value of [mandateId, 1_000_000n, 0n, 500_000n]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeBigInt64LE(1_797_713_870n, o);
  o += 8;
  for (const value of [0n, 0n, 0n]) {
    buf.writeBigUInt64LE(value, o);
    o += 8;
  }
  buf.writeUInt32LE(purpose.length, o);
  o += 4;
  purpose.copy(buf, o);
  o += purpose.length;
  buf[o] = 0;
  o += 1;
  buf.writeUInt32LE(0, o);
  o += 4;
  buf.writeUInt32LE(0, o);
  o += 4;
  buf[o] = 255;
  return buf;
}

function chargeTx(mandate: PublicKey, ledger: PublicKey): unknown {
  return {
    slot: 4,
    blockTime: 1_790_200_100,
    transaction: {
      message: {
        staticAccountKeys: [AGENT, DEST, ledger, mandate, SOURCE, MINT, PROGRAM, TOKEN_PROGRAM_ID],
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 3, 2, 4, 1, 5, 7],
            data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(100_000n), u64Le(1n)]),
          },
        ],
      },
    },
    meta: { err: null, logMessages: [`Program ${PROGRAM.toBase58()} invoke [1]`, `Program ${PROGRAM.toBase58()} success`] },
  };
}

function decision(mandate: PublicKey): IndexedDecision {
  return {
    signature: SIG,
    timestamp: 1_790_200_100,
    mandate: mandate.toBase58(),
    amount: 100_000n,
    nonce: 1n,
    counterparty: DEST.toBase58(),
    kind: "paid",
    reason: 0,
    suggestedOverride: 0n,
  };
}

function connFor(
  mandateId: bigint,
  ledgerAnswer: "missing" | "transport",
): { conn: Connection; mandate: PublicKey } {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const mandateData = encodeMandate(mandateId);
  const conn = {
    async getTransaction(signature: string) {
      return signature === SIG ? chargeTx(mandate, ledger) : null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(mandate)) {
        return { data: mandateData, owner: PROGRAM, executable: false, lamports: 1 };
      }
      if (address.equals(ledger)) {
        if (ledgerAnswer === "transport") throw new TransportError("502 Bad Gateway", 502);
        return null;
      }
      return null;
    },
    async getSignaturesForAddress() {
      return [
        {
          signature: SIG,
          slot: 4,
          err: null,
          memo: null,
          blockTime: 1_790_200_100,
          confirmationStatus: "confirmed" as const,
        },
      ];
    },
  } as unknown as Connection;
  return { conn, mandate };
}

function exportLive(mandateId: bigint, ledgerAnswer: "missing" | "transport") {
  const { conn, mandate } = connFor(mandateId, ledgerAnswer);
  return recordsFromIndexedDecisions({
    conn,
    programId: PROGRAM,
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    decisions: [decision(mandate)],
  });
}

test("issue 208: a transport error reading the live ledger fails the indexer export", async () => {
  await assert.rejects(exportLive(2081n, "transport"), (err: unknown) => {
    assert.equal(isTransportError(err), true);
    return true;
  });
});

test("issue 208: a live mandate with no ledger fails the indexer export", async () => {
  await assert.rejects(exportLive(2082n, "missing"), /ledger account not found/);
});
