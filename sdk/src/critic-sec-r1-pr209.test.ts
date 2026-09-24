// Security critic, round 1 on PR 209 (docs/phase2-191, closes #191).
//
// The submission docs say a new charge against the quoted rule
// (CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g, id 1) "is reason 7, delegation
// withdrawn", and VIDEO.md adds "before any limit is checked". The program's
// evaluate() returns OVER_PER_TX_MAX (5) and OVER_CAP (6) before it reads the
// delegate, so that sentence holds only for an amount inside the limits. At the
// doc's own 6232500 the answer today is reason 5. Simulated on devnet with
// sigVerify off (R4); nothing was sent.
//
// R1 is RED on cf028a8. R2, R3 are green controls. R4 runs only with VETO_RPC set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { CHARGE_DISCRIMINATOR, PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = ["docs/PITCH.md", "docs/VIDEO.md", "docs/DECK.md", "docs/SECURITY_REVIEW.md", "README.md"];

/** A sentence that says a charge is reason 7 has to bound the amount first. */
const QUALIFIER =
  /(inside|within|under|at or under|below) (the|its|both|those|that rule's|every) (limits?|ceiling|per-payment maximum|cap)|under 0\.5|the limits would allow|allowed by the limits|that the limits allow|passes (the|its) limits/i;

function sentences(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s+/g, " ").split(/(?<=\.)\s+(?=[A-Z`"'(-])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

test("R1: every sentence that calls a charge against the quoted rule reason 7 bounds the amount", () => {
  const offenders: string[] = [];
  for (const rel of DOCS) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const sentence of sentences(text)) {
      if (!/reason 7/.test(sentence) || !/charge/i.test(sentence)) continue;
      if (/before any limit is checked/i.test(sentence) || !QUALIFIER.test(sentence)) {
        offenders.push(`${rel}: ${sentence}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `evaluate() returns reason 5 and 6 before it reads the delegate (programs/veto/src/lib.rs), so these overstate:\n${offenders.join("\n")}`,
  );
});

test("R2 control: evaluate() checks per-payment maximum and cap before the delegate", () => {
  const lib = readFileSync(join(ROOT, "programs/veto/src/lib.rs"), "utf8");
  const body = lib.slice(lib.indexOf("fn evaluate("), lib.indexOf("fn suggested_override("));
  const perTx = body.indexOf("return REASON_OVER_PER_TX_MAX");
  const cap = body.indexOf("return REASON_OVER_CAP");
  const delegate = body.indexOf("return REASON_DELEGATE_MISSING");
  assert.ok(perTx > 0 && cap > 0 && delegate > 0, "all three returns are in evaluate()");
  assert.ok(perTx < delegate && cap < delegate, "limits are checked before the delegate");
});

test("R3 control: the general revoke sentence in README.md is not a charge claim and is left alone", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const hits = sentences(readme).filter((s) => /records reason 7/.test(s));
  assert.equal(hits.length, 1, "The program notices that and records reason 7.");
  assert.doesNotMatch(hits[0] ?? "", /charge/i);
});

const RULE_1 = {
  mandate: new PublicKey("CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g"),
  agent: new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w"),
  mint: new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU"),
  source: new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE"),
  merchant: new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG"),
};

async function simulateCharge(rpc: string, amount: bigint, nonce: bigint): Promise<string> {
  const destination = getAssociatedTokenAddressSync(RULE_1.mint, RULE_1.merchant, true, TOKEN_PROGRAM_ID);
  const data = Buffer.alloc(24);
  CHARGE_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(nonce, 16);
  const tx = new Transaction();
  tx.feePayer = RULE_1.agent;
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.add(
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: RULE_1.agent, isSigner: true, isWritable: false },
        { pubkey: RULE_1.mandate, isSigner: false, isWritable: true },
        { pubkey: ledgerPda(PROGRAM_ID, RULE_1.mandate), isSigner: false, isWritable: true },
        { pubkey: RULE_1.source, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: RULE_1.mint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    }),
  );
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }],
    }),
  });
  const json = (await res.json()) as { result?: { value?: { err: unknown; logs: string[] | null } } };
  const value = json.result?.value;
  assert.ok(value, "simulateTransaction returned a value");
  assert.equal(value.err, null, `simulation error ${JSON.stringify(value.err)}`);
  const line = (value.logs ?? []).find((l) => l.includes("VETO "));
  assert.ok(line, "a Veto log line");
  return line;
}

test(
  "R4 live: on devnet the quoted rule refuses the doc's own amount as reason 5 and an in-limit amount as reason 7",
  { skip: process.env.VETO_RPC ? false : "set VETO_RPC to simulate against the cluster (unsigned, nothing is sent)" },
  async () => {
    const rpc = process.env.VETO_RPC ?? "";
    const nonce = 1_789_920_001n;
    assert.match(await simulateCharge(rpc, 6_232_500n, nonce), /VETO REFUSED reason=5 \(over per-payment maximum\) amount=6232500/);
    assert.match(await simulateCharge(rpc, 100_000n, nonce), /VETO REFUSED reason=7 \(delegation withdrawn\) amount=100000/);
  },
);
