import { CliError } from "./errors.js";

/** Genesis hashes VetoAgent.fromMandate accepts for the clusters this command offers. */
export const GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;

export type Cluster = keyof typeof GENESIS;

export const DEFAULT_RPC: Readonly<Record<Cluster, string>> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

export function parseCluster(value: string | undefined): Cluster {
  if (value === undefined || value.trim() === "") return "devnet";
  if (value === "devnet" || value === "mainnet-beta") return value;
  throw new CliError("Cluster must be devnet or mainnet-beta.");
}

export async function assertGenesis(
  connection: { getGenesisHash(): Promise<string> },
  cluster: Cluster,
): Promise<void> {
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`Could not read the RPC genesis hash: ${message}`);
  }
  if (genesis !== GENESIS[cluster]) {
    throw new CliError(`This RPC does not match ${cluster}.`);
  }
}

export function explorerTx(signature: string, cluster: Cluster): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}
