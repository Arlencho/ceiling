import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  decisionsForMandate,
  VetoAgent,
  type PurposeCheckContext,
  type PurposeCheckResult,
} from "../src/index.js";

const ENDPOINT_FAILED = "purpose check endpoint failed";
const ANSWER_UNREADABLE = "purpose check answer was not understood";

/**
 * Posts the charge context to an HTTP endpoint and reads `{ allow, reason }`.
 * The endpoint URL is PURPOSE_CHECK_URL. This file does not name or bundle a model.
 * A transport error, a non-2xx response, or a body that is not that shape declines.
 */
export async function purposeCheckAt(url: string, ctx: PurposeCheckContext): Promise<PurposeCheckResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: ctx.purpose,
        amount: ctx.amount.toString(),
        decimals: ctx.decimals,
        payee: ctx.payee,
        mandate: ctx.mandate,
        description: ctx.description,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { allow: false, reason: ENDPOINT_FAILED };
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { allow: false, reason: ANSWER_UNREADABLE };
    }
    const allow = (body as { allow?: unknown }).allow;
    const reason = (body as { reason?: unknown }).reason;
    if (typeof allow !== "boolean" || typeof reason !== "string") {
      return { allow: false, reason: ANSWER_UNREADABLE };
    }
    return { allow, reason };
  } catch {
    return { allow: false, reason: ENDPOINT_FAILED };
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));
}

async function main(): Promise<void> {
  const [keyFile, mandateArg, amountArg, description] = process.argv.slice(2);
  const url = process.env.PURPOSE_CHECK_URL;
  if (!keyFile || !mandateArg || !amountArg || description === undefined || !url) {
    throw new Error(
      "usage: PURPOSE_CHECK_URL=<endpoint> npx tsx examples/purpose-check.ts <agent-key.json> <mandate> <amount> <description>",
    );
  }
  const secret = JSON.parse(readFileSync(keyFile, "utf8")) as number[];
  const agent = Keypair.fromSecretKey(Uint8Array.from(secret));
  const mandate = new PublicKey(mandateArg);
  const rpcUrl = process.env.VETO_RPC ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const veto = new VetoAgent({
    connection,
    agent,
    mandate,
    purposeCheck: (ctx) => purposeCheckAt(url, ctx),
  });
  const outcome = await veto.chargeWithPurposeCheck({
    amount: BigInt(amountArg),
    nonce: await veto.nextNonce(),
    description,
  });
  printJson(outcome);
  if (outcome.kind !== "advisory_declined") return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const page = await decisionsForMandate(connection, mandate, { pageSize: 5 });
    const row = page.find((item) => item.signature === outcome.signature);
    if (row) {
      printJson({
        signature: row.signature,
        kind: row.kind,
        reasonText: row.reasonText,
        advisoryReason: row.advisoryReason,
        amount: row.amount,
        nonce: row.nonce,
        mandate: row.mandate,
        descriptionSha256: row.descriptionSha256,
      });
      return;
    }
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`reader did not return advisory memo ${outcome.signature}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
