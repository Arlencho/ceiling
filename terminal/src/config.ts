/** Terminal config: the same sources as the watcher and indexer.
 *
 * RPC, program id, mint and the merchant token account come from the shared
 * loader (environment, keys/devnet-addresses.env, or the package .env). Only
 * the HTTP port is terminal-specific. Nothing is hardcoded here.
 */

import { loadConfig } from "../../watcher/src/config.js";

export type TerminalConfig = {
  rpc: string;
  programId: string;
  mint: string;
  merchant: string;
  merchantTokenAccount: string;
  kwhMilli: bigint;
  mintDecimals: number;
  port: number;
  explorerQuery: string;
};

export function explorerQueryFor(rpc: string): string {
  if (rpc.includes("devnet")) return "?cluster=devnet";
  if (rpc.includes("testnet")) return "?cluster=testnet";
  return "";
}

export function loadTerminalConfig(env: NodeJS.ProcessEnv = process.env): TerminalConfig {
  const base = loadConfig(env);
  const port = Number.parseInt(env.VETO_TERMINAL_PORT ?? "8788", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`terminal.loadTerminalConfig: bad VETO_TERMINAL_PORT: ${env.VETO_TERMINAL_PORT ?? ""}`);
  }
  return {
    rpc: base.rpc,
    programId: base.programId,
    mint: base.mint,
    merchant: base.merchant,
    merchantTokenAccount: base.merchantTokenAccount,
    kwhMilli: base.kwhMilli,
    mintDecimals: base.mintDecimals,
    port,
    explorerQuery: explorerQueryFor(base.rpc),
  };
}
