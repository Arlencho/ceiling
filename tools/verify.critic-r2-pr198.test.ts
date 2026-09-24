// Backend critic, PR 198 round 2.
// R2-1: commit 791cb04 routes eq() (record.genesis_hash at verify.ts:110) and
//       the envelope program_id and genesis_hash (verify.ts:758, :762) through
//       echoFile, whose class is now Cc, Cf, Cs, Co, Cn, U+2028 and U+2029.
//       Round 1 C3 proved those sites with LF only, and the security B1 proved
//       the wide class on cluster, reason_text and signature. This is the
//       cross: the wide class on the eq() and envelope sites, single and bundle.
// R2-2: regression check on the new signature gate (lib.ts fileSignature,
//       loadedSignature): labels below 32 characters and a 31-character base58
//       label still parse, a 32-character base58 label and a lone surrogate at
//       any length do not, and echoFile is identity on base58 and ASCII.
// R2-3: todo, issue 201, pre-existing and outside the fix diff: parse-time
//       errors reach stderr through verify.ts:1333 with the raw file text.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { echoFile, makeBundle, parseExportText } from "./bulk.js";
import { mandatePda, parseRecord, reasonText, type DecisionRecord } from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const HONEST = "5".repeat(87);

// One representative per class echoFile names, plus the two separators.
const UNSAFE: [string, string, string][] = [
  ["U+2028 line separator", "\u2028", "\\u2028"],
  ["U+2029 paragraph separator", "\u2029", "\\u2029"],
  ["U+0085 NEL (Cc)", "\u0085", "\\u0085"],
  ["U+009B single-byte CSI (Cc)", "\u009b", "\\u009b"],
  ["U+202E bidi override (Cf)", "\u202E", "\\u202e"],
  ["U+200B zero width space (Cf)", "\u200B", "\\u200b"],
  ["U+D800 lone surrogate (Cs)", "\ud800", "\\ud800"],
  ["U+E000 private use (Co)", "\uE000", "\\ue000"],
];

// Every line break a consumer might split on: CR, LF, NEL, LS, PS.
const LINE_SPLIT = /\r\n|[\n\r\u0085\u2028\u2029]/;
const RAW_UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;

function plain(signature: string): Record<string, unknown> {
  return {
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandatePda(PROGRAM, OWNER, 9298n).toBase58(),
    limits: {
      cap: 1_000_000,
      per_tx_max: 500_000,
      expires_at: 1_797_713_870,
      merchant: MERCHANT.toBase58(),
      purpose: "critic r2 pr198",
    },
    kind: "paid",
    amount: 10,
    counterparty: DEST.toBase58(),
    timestamp: 1_790_117_960,
    nonce: 1,
    reason_code: 0,
    reason_text: reasonText(0),
    suggested_override: 0,
    signature,
  };
}

function ruleBundle(rows: DecisionRecord[]) {
  return makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM.toBase58(),
    scope: { type: "rule", mandate: rows[0]!.mandate, from: null, to: null },
    decisions: rows,
  });
}

function nullNode(): Connection {
  return {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getTransaction() {
      return null;
    },
    async getAccountInfo() {
      return null;
    },
    async getSignaturesForAddress() {
      return [];
    },
  } as unknown as Connection;
}

function verdictLines(text: string): string[] {
  return text.split(LINE_SPLIT).filter((line) => line.startsWith("VERDICT:"));
}

test("critic r2 pr198 R2-1: the wide class in record.genesis_hash, envelope program_id, or envelope genesis_hash is escaped at the eq() and envelope sites", async () => {
  const base = parseRecord(plain("sig-r2"));
  const bundle = ruleBundle([base]);
  const leaked: string[] = [];
  for (const [label, ch, escaped] of UNSAFE) {
    const planted = `x${ch}VERDICT: CONFIRMED`;
    const sites: [string, () => Promise<{ text: string; code: number }>][] = [
      ["record.genesis_hash (single)", () => assessRecord({ ...base, genesis_hash: planted }, RPC, nullNode(), OPTS)],
      [
        "record.genesis_hash (bundle row)",
        () => assessBundle({ ...bundle, decisions: [{ ...base, genesis_hash: `y${planted}` }] }, RPC, nullNode(), OPTS),
      ],
      ["envelope program_id", () => assessBundle({ ...bundle, program_id: planted }, RPC, nullNode(), OPTS)],
      ["envelope genesis_hash", () => assessBundle({ ...bundle, genesis_hash: planted }, RPC, nullNode(), OPTS)],
    ];
    for (const [site, run] of sites) {
      const result = await run();
      const lines = verdictLines(result.text);
      const problems: string[] = [];
      if (result.code !== 1) problems.push(`code ${result.code}`);
      if (lines.length !== 1 || lines[0] !== "VERDICT: REJECTED") problems.push(`verdict lines ${JSON.stringify(lines)}`);
      if (RAW_UNSAFE.test(result.text.replace(/\n/g, ""))) problems.push("raw character in report");
      if (!result.text.includes(escaped)) problems.push(`escape ${escaped} not printed`);
      if (problems.length > 0) leaked.push(`${label} in ${site}: ${problems.join(", ")}`);
    }
  }
  assert.deepEqual(leaked, [], `leaks:\n${leaked.join("\n")}`);
});

test("critic r2 pr198 R2-2: the signature gate keeps labels and chain signatures and rejects a pubkey-sized base58 label and a lone surrogate at any length", () => {
  const accepted = (signature: string): boolean => {
    try {
      parseRecord(plain(signature));
      return true;
    } catch {
      return false;
    }
  };
  const wrong: string[] = [];
  for (const [label, signature, want] of [
    ["short label", "sig-r2", true],
    ["31-character base58 label", "5".repeat(31), true],
    ["chain signature", HONEST, true],
    ["32-character base58 label", "5".repeat(32), false],
    ["44-character base58 (32 bytes)", "11111111111111111111111111111111111111111112", false],
    ["lone surrogate, 4 characters", "sig\ud800", false],
    ["lone surrogate, 40 characters", `${"s".repeat(39)}\ud800`, false],
    ["lone surrogate, 87 characters", `${"5".repeat(86)}\ud800`, false],
    ["89 characters of base58", "5".repeat(89), false],
  ] as const) {
    if (accepted(signature) !== want) wrong.push(`${label}: ${want ? "rejected" : "accepted"}`);
  }
  assert.deepEqual(wrong, [], wrong.join("; "));
  assert.equal(echoFile(HONEST), HONEST);
  assert.equal(echoFile(reasonText(0)), reasonText(0));
  assert.equal(echoFile(DEVNET_GENESIS), DEVNET_GENESIS);
});

test(
  "critic r2 pr198 R2-3: a parse-time error carries no raw file text (pre-existing, bulk.ts:244 and :563)",
  { todo: "issue 201, outside the PR 198 fix diff" },
  () => {
    const messages: string[] = [];
    for (const raw of [
      JSON.stringify({ ...ruleBundle([parseRecord(plain("sig-r2-3"))]), schema_version: "1\u2028VERDICT: CONFIRMED" }),
      "[1,\u2028",
    ]) {
      try {
        parseExportText(raw);
        messages.push("accepted");
      } catch (err) {
        messages.push(err instanceof Error ? err.message : String(err));
      }
    }
    const raw = messages.filter((m) => RAW_UNSAFE.test(m));
    assert.deepEqual(raw, [], `raw text in: ${JSON.stringify(raw)}`);
  },
);
