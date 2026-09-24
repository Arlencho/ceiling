import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { RuleRequestRejected, createRuleRequest } from "../src/index.js";

const [keyFile, payee, mint, cap, max, days, purpose, agentLabel, payeeLabel] = process.argv.slice(2);
if (!keyFile || !payee || !mint || !cap || !max || !days || purpose === undefined) {
  console.error(
    "usage: npx tsx examples/rule-request.ts <agent-key.json> <payee> <mint> <cap> <max> <days> <purpose> [agentLabel] [payeeLabel]",
  );
  process.exit(1);
}

const secret = JSON.parse(readFileSync(keyFile, "utf8")) as number[];
const agent = Keypair.fromSecretKey(Uint8Array.from(secret));

try {
  const url = createRuleRequest({
    agent: agent.publicKey.toBase58(),
    payee,
    mint,
    cap,
    max,
    days,
    purpose,
    agentLabel,
    payeeLabel,
  });
  console.log(url);
} catch (err) {
  if (err instanceof RuleRequestRejected) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
