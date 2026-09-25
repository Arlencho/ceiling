import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Read only: verify mainnet, then capture finalized bytes and their response slot. */
export async function snapshotAccount(
  address: string,
  rpc = process.env.VETO_MAINNET_RPC || "https://api.mainnet-beta.solana.com",
  fetcher: typeof fetch = fetch,
) {
  const key = new PublicKey(address).toBase58();
  async function request(method: string, params: unknown[] = []) {
    try {
      const response = await fetcher(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (body.error || body.result === undefined) throw new Error();
      return body.result;
    } catch {
      // Providers can echo credentials in errors, URLs and response bodies.
      throw new Error("snapshot-account: RPC request failed");
    }
  }
  if (await request("getGenesisHash") !== MAINNET_GENESIS) {
    throw new Error("snapshot-account: endpoint is not mainnet");
  }
  const result = await request("getAccountInfo", [key, { encoding: "base64", commitment: "finalized" }]);
  if (result.value === null) throw new Error("snapshot-account: account not found");
  try {
    const { value, context } = result;
    if (!Number.isSafeInteger(value.lamports) || value.lamports < 0 ||
        !Number.isSafeInteger(context.slot) || context.slot < 0 ||
        !Array.isArray(value.data) || value.data[1] !== "base64" ||
        typeof value.data[0] !== "string" ||
        Buffer.from(value.data[0], "base64").toString("base64") !== value.data[0]) throw new Error();
    return {
      address: key,
      owner: new PublicKey(value.owner).toBase58(),
      lamports: value.lamports as number,
      data_base64: value.data[0] as string,
      slot: context.slot as number,
      fetched_at: new Date().toISOString(),
    };
  } catch {
    throw new Error("snapshot-account: invalid account response");
  }
}

async function main() {
  const [address, output, ...extra] = process.argv.slice(2);
  if (!address || !output || extra.length) {
    throw new Error("Usage: npx tsx snapshot-account.ts <address> <output.json>");
  }
  const snapshot = await snapshotAccount(address);
  await writeFile(output, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Do not print raw exceptions, including filesystem paths supplied by the caller.
    console.error("snapshot-account failed: check address, output path and mainnet RPC availability");
    process.exitCode = 1;
  });
}
