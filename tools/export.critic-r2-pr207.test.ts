// Backend critic, PR 207 round 2. Closes F2 on every Unicode line terminator at
// the three completeness sites (bulk.ts:252, :420, :452), and names one
// regression check for the 208 fix: the --signature path fails the export on a
// ledger transport error and on a missing ledger under a live mandate, the same
// way the indexer path now does (export.ts:89-103, ledgerForCurrentTenure).
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TransportError, isTransportError } from "../indexer/src/rpc.js";
import { parseExportText } from "./bulk.js";
import { recordFromSignature } from "./export.js";
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

// R2-1: every line terminator Unicode names (UAX #14 BK/CR/LF/NL plus VT and
// FF), written by code point so the file itself carries none of them raw.
const TERMINATORS = [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029].map((cp) => String.fromCodePoint(cp));
const RAW_UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
const LINE_SPLIT = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;

function assertParseError(raw: string, site: string, needCompleteness = true): void {
  let message = "";
  try {
    parseExportText(raw);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.notEqual(message, "", `${site}: expected a parse error`);
  if (needCompleteness) {
    assert.match(message, /completeness/, `${site}: expected a completeness error, got ${JSON.stringify(message)}`);
  }
  assert.equal(RAW_UNSAFE.test(message), false, `${site}: ${JSON.stringify(message)}`);
  const lines = `verify failed: ${message}`.split(LINE_SPLIT);
  assert.equal(lines.length, 1, `${site}: message split into ${lines.length} lines ${JSON.stringify(lines)}`);
}

const BUNDLE = {
  schema_version: 1,
  completeness: "payments",
  completeness_note: "complete over payments",
  cluster: "devnet",
  genesis_hash: DEVNET_GENESIS,
  program_id: PROGRAM.toBase58(),
  scope: {},
  decisions: [],
};

test("critic r2 pr207 R2-1: every Unicode line terminator in completeness stays on one operator line at bulk.ts:252, :420, :452", () => {
  for (const sep of TERMINATORS) {
    const tag = `U+${(sep.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
    const payload = `payments${sep}VERDICT: CONFIRMED`;
    assertParseError(JSON.stringify({ ...BUNDLE, completeness: payload }), `json ${tag}`);
    // LF and CR split the CSV row before :420 or :452 see the field, so the
    // error there is a different one; it still has to be one clean line.
    const reaches = sep !== "\n" && sep !== "\r";
    const row = ["signature,kind,amount,mandate,completeness", `sig,paid,1,mandate,${payload}`].join("\n");
    assertParseError(row, `csv row ${tag}`, reaches);
    const meta = ["signature,kind,amount,mandate", `# completeness=${payload}`].join("\n");
    assertParseError(meta, `csv meta ${tag}`, reaches);
  }
});

// R2-2, R2-3: the regression check named for the 208 fix on the other path.
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

function liveChain(mandateId: bigint, ledgerAnswer: "missing" | "transport"): Connection {
  const mandate = mandatePda(PROGRAM, OWNER, mandateId);
  const ledger = ledgerPda(PROGRAM, mandate);
  const mandateData = encodeMandate(mandateId);
  return {
    async getTransaction(signature: string) {
      return signature === SIG ? chargeTx(mandate, ledger) : null;
    },
    async getAccountInfo(address: PublicKey) {
      if (address.equals(mandate)) return { data: mandateData, owner: PROGRAM, executable: false, lamports: 1 };
      if (address.equals(ledger) && ledgerAnswer === "transport") throw new TransportError("502 Bad Gateway", 502);
      return null;
    },
    async getSignaturesForAddress() {
      return [{ signature: SIG, slot: 4, err: null, memo: null, blockTime: 1_790_200_100, confirmationStatus: "confirmed" as const }];
    },
  } as unknown as Connection;
}

test("critic r2 pr207 R2-2: export --signature fails on a ledger transport error under a live mandate", async () => {
  await assert.rejects(
    recordFromSignature(liveChain(2201n, "transport"), SIG, PROGRAM, "devnet", DEVNET_GENESIS),
    (err: unknown) => {
      assert.equal(isTransportError(err), true, String(err));
      return true;
    },
  );
});

test("critic r2 pr207 R2-3: export --signature fails when a live mandate has no ledger", async () => {
  await assert.rejects(
    recordFromSignature(liveChain(2202n, "missing"), SIG, PROGRAM, "devnet", DEVNET_GENESIS),
    /ledger account not found/,
  );
});
