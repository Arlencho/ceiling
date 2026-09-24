import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { loadAgentConfig, VetoAgent } from "../src/index.js";

const [keyFile, configFile, amount] = process.argv.slice(2);
if (!keyFile || !configFile || !amount) {
  throw new Error("usage: npx tsx examples/pay-once.ts <agent-key.json> <config.json> <amount>");
}
const secret = JSON.parse(readFileSync(keyFile, "utf8")) as number[];
const agent = Keypair.fromSecretKey(Uint8Array.from(secret));
const config = loadAgentConfig(readFileSync(configFile, "utf8"));
// rpcUrl in the block is used when no Connection is passed. A Connection
// argument is the endpoint instead. Either one must match the block's cluster.
// The program is the bundled id. Pass { programId } to select a localnet build.
const veto = await VetoAgent.fromConfig(config, agent);
const outcome = await veto.charge({ amount: BigInt(amount), nonce: await veto.nextNonce() });
console.log(
  `${outcome.kind} ${outcome.reasonCode} ${outcome.reasonText} ${outcome.suggestedOverride} ${outcome.signature} ${outcome.slot}`,
);
