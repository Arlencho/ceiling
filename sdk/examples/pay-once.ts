import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { VetoAgent } from "../src/index.js";

const [keyFile, mandate, amount] = process.argv.slice(2);
if (!keyFile || !mandate || !amount) {
  throw new Error("usage: npx tsx examples/pay-once.ts <agent-key.json> <mandate> <amount>");
}
const secret = JSON.parse(readFileSync(keyFile, "utf8")) as number[];
const agent = Keypair.fromSecretKey(Uint8Array.from(secret));
const veto = new VetoAgent({
  connection: new Connection("https://api.devnet.solana.com", "confirmed"),
  agent,
  mandate: new PublicKey(mandate),
});
const outcome = await veto.charge({ amount: BigInt(amount), nonce: await veto.nextNonce() });
console.log(
  `${outcome.kind} ${outcome.reasonCode} ${outcome.reasonText} ${outcome.suggestedOverride} ${outcome.signature} ${outcome.slot}`,
);
