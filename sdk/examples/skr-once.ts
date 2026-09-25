import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import { VetoAgent } from "../src/index.js";

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

async function main() {
  const rpc = process.env.VETO_RPC;
  const rule = process.env.VETO_RULE;
  const keyFile = process.env.VETO_AGENT_KEY;
  if (!rpc || !rule || !keyFile) {
    throw new Error("Set VETO_RPC, VETO_RULE and VETO_AGENT_KEY.");
  }
  const mint = new PublicKey(
    process.env.VETO_MINT ?? "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
  );
  const secret = JSON.parse(readFileSync(keyFile, "utf8")) as number[];
  const agent = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(rpc, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  const veto = await VetoAgent.fromMandate(connection, new PublicKey(rule), agent);
  const status = await veto.status();
  if (!new PublicKey(status.mint).equals(mint)) {
    throw new Error("The rule mint does not match VETO_MINT.");
  }
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintInfo || unpackMint(mint, mintInfo, mintInfo.owner).decimals !== DECIMALS) {
    throw new Error("The configured mint must have 6 decimals.");
  }
  // Check the intended limits before submitting either charge.
  if (status.perTxMax < 8n * UNIT || status.perTxMax >= 25n * UNIT
      || status.remaining < 8n * UNIT || status.overrideNonce > status.lastNonce) {
    throw new Error("The rule needs room for 8, a maximum below 25, and no pending override.");
  }
  for (const [amount, expected] of [[8n, "paid"], [25n, "refused"]] as const) {
    const outcome = await veto.charge({ amount: amount * UNIT, nonce: await veto.nextNonce() });
    console.log(
      `${amount} SKR ${outcome.kind} ${outcome.reasonCode} ${outcome.reasonText} ${outcome.signature} ${outcome.slot}`,
    );
    if (outcome.kind !== expected) {
      throw new Error("The charge did not produce the expected decision.");
    }
  }
}

// RPC errors can contain endpoint credentials. Never print the caught error.
await main().catch(() => {
  console.error("SKR example failed. Check the environment, key file, rule mint, decimals and limits, and RPC availability.");
  process.exitCode = 1;
});
