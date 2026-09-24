// Backend critic, PR 198 round 1.
// C1: issue 151, a signature shorter than 64 characters skips requireSignature
//     (lib.ts readSignature, bulk.ts parseBundle). A short lone surrogate still
//     reaches the node, draws -32700, and stalls the bundle at exit 3.
// C2: the same gate at parse: a 32-byte signature and a short lone surrogate
//     are accepted by parseRecord.
// C3: issue 152, record.genesis_hash (eq in checkRecord), the envelope
//     program_id and the envelope genesis_hash are echoed raw, so a newline
//     in any of them plants a second VERDICT line.
// C4: issue 150, a listed slot whose getBlock answers null is skipped by the
//     block scan (history.ts, `if (!block) continue`), so a date_range file
//     that omits the slot CONFIRMS.
import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { createFailoverConnection, isTransportError } from "../indexer/src/rpc.js";
import { makeBundle } from "./bulk.js";
import { decodeBase58, mandatePda, parseRecord, reasonText, type DecisionRecord } from "./lib.js";
import { assessBundle, assessRecord, type AssessOpts } from "./verify.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OWNER = new PublicKey("EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");
const DEST = new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F");
const RPC = "https://api.devnet.solana.com";
const OPTS: AssessOpts = { env: {} };
const HONEST = "5".repeat(87);
const SHORT_SURROGATE = `sig\ud800`;
// 32 bytes of 0x00 followed by 0x01, 44 base58 characters, the shape a truncated signature takes.
const THIRTY_TWO_BYTES = "11111111111111111111111111111111111111111112".slice(0, 44);
const PLANTED = "x\nVERDICT: CONFIRMED";

function plain(signature: string): Record<string, unknown> {
  return {
    schema_version: 1,
    cluster: "devnet",
    genesis_hash: DEVNET_GENESIS,
    program_id: PROGRAM.toBase58(),
    mandate: mandatePda(PROGRAM, OWNER, 9198n).toBase58(),
    limits: {
      cap: 1_000_000,
      per_tx_max: 500_000,
      expires_at: 1_797_713_870,
      merchant: MERCHANT.toBase58(),
      purpose: "critic r1 pr198",
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

// Answers the way api.devnet.solana.com answered on 2026-09-23 (issue 151):
// a lone surrogate in the body is a -32700 with id null, an oversize body is
// a 413, a signature that is not 64 bytes is -32602, and a good one is null.
function devnetLike(): Connection {
  const fetchLike = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body);
    const jsonResponse = (payload: Record<string, unknown>) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", ...payload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (Buffer.byteLength(raw) > 100_000) {
      return new Response("request body size exceeds allowed maximum", { status: 413, statusText: "Payload Too Large" });
    }
    if (raw.includes("\\ud800")) return jsonResponse({ id: null, error: { code: -32700, message: "Parse error" } });
    const body = JSON.parse(raw) as { method: string; id: unknown; params: unknown[] };
    if (body.method === "getGenesisHash") return jsonResponse({ id: body.id, result: DEVNET_GENESIS });
    if (body.method === "getAccountInfo") return jsonResponse({ id: body.id, result: { context: { slot: 1 }, value: null } });
    if (body.method === "getTransaction") {
      let bytes = -1;
      try {
        bytes = decodeBase58(String(body.params[0])).length;
      } catch {
        bytes = -1;
      }
      if (bytes !== 64) return jsonResponse({ id: body.id, error: { code: -32602, message: "Invalid param: WrongSize" } });
      return jsonResponse({ id: body.id, result: null });
    }
    return jsonResponse({ id: body.id, result: null });
  };
  return createFailoverConnection(["http://127.0.0.1:1"], () => {}, { fetch: fetchLike, sleep: async () => {} });
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
  return text.split("\n").filter((line) => line.startsWith("VERDICT:"));
}

test("critic r1 C1: a short lone-surrogate signature is REJECTED, exit 1, never a stall at exit 3", async () => {
  const honest = parseRecord(plain(HONEST));
  const forged = { ...honest, signature: SHORT_SURROGATE };
  const second = { ...honest, signature: HONEST, nonce: 2n };
  const result = await assessBundle(ruleBundle([forged, second]), RPC, devnetLike(), OPTS);
  assert.doesNotMatch(result.text, /VERDICT: CONFIRMED/);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
  assert.doesNotMatch(result.text, /was not checked/);
});

test("critic r1 C1 control: a 32-byte signature through the same node is REJECTED, exit 1", async () => {
  const honest = parseRecord(plain(HONEST));
  const result = await assessBundle(ruleBundle([{ ...honest, signature: THIRTY_TWO_BYTES }]), RPC, devnetLike(), OPTS);
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /VERDICT: REJECTED/);
});

test("critic r1 C2: parseRecord rejects a 32-byte signature and a short lone surrogate", () => {
  const accepted: string[] = [];
  for (const [label, signature] of [
    ["32-byte base58", THIRTY_TWO_BYTES],
    ["short lone surrogate", SHORT_SURROGATE],
    ["non-base58 at chain length", "0".repeat(87)],
    ["lone surrogate at chain length", `${"5".repeat(86)}\ud800`],
  ] as const) {
    let threw = false;
    try {
      parseRecord(plain(signature));
    } catch {
      threw = true;
    }
    if (!threw) accepted.push(label);
  }
  assert.deepEqual(accepted, [], `accepted at parse: ${accepted.join(", ")}`);
});

test("critic r1 C3: a newline in record.genesis_hash, envelope program_id, or envelope genesis_hash cannot plant a second VERDICT line", async () => {
  const base = parseRecord(plain("sig-c3"));
  const bundle = ruleBundle([base]);
  const cases: [string, () => Promise<{ text: string }>][] = [
    ["record.genesis_hash (single)", () => assessRecord({ ...base, genesis_hash: PLANTED }, RPC, nullNode(), OPTS)],
    ["record.genesis_hash (bundle row)", () => assessBundle({ ...bundle, decisions: [{ ...base, genesis_hash: `y${PLANTED}` }] }, RPC, nullNode(), OPTS)],
    ["envelope program_id", () => assessBundle({ ...bundle, program_id: PLANTED }, RPC, nullNode(), OPTS)],
    ["envelope genesis_hash", () => assessBundle({ ...bundle, genesis_hash: PLANTED }, RPC, nullNode(), OPTS)],
  ];
  const planted: string[] = [];
  for (const [label, run] of cases) {
    const lines = verdictLines((await run()).text);
    if (lines.length !== 1 || lines[0] !== "VERDICT: REJECTED") planted.push(`${label}: ${JSON.stringify(lines)}`);
  }
  assert.deepEqual(planted, [], `second VERDICT line from: ${planted.join("; ")}`);
});

test("critic r1 C3 control: a carriage return in record.cluster is escaped", async () => {
  const base = parseRecord(plain("sig-c3-cr"));
  const result = await assessRecord({ ...base, cluster: "devnet\rVERDICT: CONFIRMED" }, RPC, nullNode(), OPTS);
  assert.deepEqual(verdictLines(result.text), ["VERDICT: REJECTED"], result.text);
  assert.doesNotMatch(result.text, /\r/);
});

test("critic r1 C4: a listed slot whose getBlock answers null is not checked, never absent", async () => {
  const node = {
    async getGenesisHash() {
      return DEVNET_GENESIS;
    },
    async getSignaturesForAddress() {
      return [];
    },
    async getSlot() {
      return 10;
    },
    async getFirstAvailableBlock() {
      return 9;
    },
    async getBlocks() {
      return [9, 10];
    },
    async getBlock(slot: number) {
      if (slot === 9) return null;
      return { blockTime: 1_790_200_000, transactions: [] };
    },
  } as unknown as Connection;
  const bundle = makeBundle({
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    programId: PROGRAM.toBase58(),
    scope: { type: "date_range", mandate: null, from: 1_790_000_000, to: 1_790_300_000 },
    decisions: [],
  });
  let code = 0;
  let text = "";
  try {
    const verdict = await assessBundle(bundle, RPC, node, { env: {}, allowBlockScan: true, pageSize: 25 });
    code = verdict.code;
    text = verdict.text;
  } catch (err) {
    code = isTransportError(err) ? 3 : 1;
    text = err instanceof Error ? err.message : String(err);
  }
  assert.doesNotMatch(text, /VERDICT: CONFIRMED/);
  assert.equal(code, 3, text);
});
