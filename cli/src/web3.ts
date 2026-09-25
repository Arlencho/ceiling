import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Connection as Web3Connection } from "@solana/web3.js";
import { CliError } from "./errors.js";

// One web3 module, the copy the SDK was installed with. A second copy makes
// `instanceof Keypair` fail inside VetoAgent.fromMandate.
const sdkEntry = fileURLToPath(import.meta.resolve("@veto-hq/agent-sdk"));
const requireSdk = createRequire(sdkEntry);
const web3 = requireSdk("@solana/web3.js") as typeof import("@solana/web3.js");

export const Connection = web3.Connection;
export const Keypair = web3.Keypair;
export const PublicKey = web3.PublicKey;
export const Transaction = web3.Transaction;

export type Connection = Web3Connection;
export type Keypair = InstanceType<typeof web3.Keypair>;
export type PublicKey = InstanceType<typeof web3.PublicKey>;

export function canonicalAddress(value: string, field: string): string {
  const trimmed = value.trim();
  try {
    const key = new PublicKey(trimmed);
    if (key.toBase58() !== trimmed) {
      throw new Error("not canonical");
    }
    return trimmed;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${field} is not a public key.`);
  }
}
