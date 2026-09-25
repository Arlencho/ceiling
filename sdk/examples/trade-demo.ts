import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { isTradeAgentConfig, loadAgentConfig, VetoAgent, type TradeResult } from "../src/index.js";

export function parseTradeArgs(args: string[]) {
  const [keyFile, selector, value, last] = args;
  const byRule = selector === "--rule";
  if (!keyFile || !selector || !value || args.length !== (byRule ? 4 : 3)) {
    throw new Error("usage: <agent-key.json> <trade-config.json> <amount> OR <agent-key.json> --rule <address> <amount>");
  }
  const raw = byRule ? last : value;
  if (!raw || !/^[0-9]+$/.test(raw) || BigInt(raw) === 0n || BigInt(raw) > 0xffffffffffffffffn) {
    throw new Error("amount must be positive u64 base units");
  }
  const amount = BigInt(raw);
  if (byRule) return { keyFile, rule: new PublicKey(value).toBase58(), amount };
  if (selector.startsWith("--")) throw new Error("unknown option");
  return { keyFile, configFile: selector, amount };
}

export function loadKey(path: string): Keypair {
  // Never include file contents or parsing errors in output.
  try {
    const bytes: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error("could not load the requested signer key file");
  }
}

export async function loadDemo(args: ReturnType<typeof parseTradeArgs>) {
  const agent = loadKey(args.keyFile);
  const rpc = process.env.VETO_RPC;
  if (args.rule) {
    if (!rpc) throw new Error("--rule requires VETO_RPC");
    return new VetoAgent({ connection: new Connection(rpc, "confirmed"), agent, rule: args.rule });
  }
  const config = loadAgentConfig(readFileSync(args.configFile!, "utf8"));
  if (!isTradeAgentConfig(config)) throw new Error("requires a trade config block");
  return VetoAgent.fromTradeConfig(config, agent, rpc ? new Connection(rpc, "confirmed") : undefined);
}

export function formatTrade(result: TradeResult): string {
  return `${result.kind} amount_in=${result.amountIn} amount_out=${result.amountOut} reason=${result.reasonCode} ${result.reasonText} suggested_override=${result.suggestedOverride} signature=${result.signature} slot=${result.slot}`;
}

export function assertExpected(result: TradeResult, reason: number, override = 0n): void {
  if (result.reasonCode !== reason || result.kind !== (reason === 0 ? "traded" : "refused")) {
    throw new Error(`expected reason ${reason}, got ${result.kind} reason ${result.reasonCode}`);
  }
  if (result.suggestedOverride !== override) throw new Error(`expected override ${override}, got ${result.suggestedOverride}`);
}

export async function runTradeOnce(veto: VetoAgent, amount: bigint, print = console.log) {
  await veto.tradeStatus();
  const result = await veto.trade({ amountIn: amount, minOut: 0n, nonce: await veto.nextTradeNonce() });
  print(formatTrade(result));
  return result;
}

export function mainIfDirect(url: string, main: () => Promise<void>): void {
  if (process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href) {
    void main().catch(error => {
      // Key decoding errors are sanitized in loadKey; redact credentialed RPC URLs too.
      console.error(String(error instanceof Error ? error.message : "demo failed").replace(/https?:\/\/[^\s]+/g, "[rpc]"));
      process.exitCode = 1;
    });
  }
}
