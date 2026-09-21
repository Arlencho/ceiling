#!/usr/bin/env node
import { PublicKey } from "@solana/web3.js";
import { compareRingToHistory } from "./compare.js";
import { DEFAULT_PROGRAM_ID, DEFAULT_RPC } from "./constants.js";
import { parseRpcList } from "./rpc.js";
import { formatComparison, formatTable, decisionToJson } from "./format.js";
import { fetchDecisionHistory } from "./history.js";
import { fetchLedgerRing } from "./ring.js";

type Args = {
  rpc: string;
  program: string;
  mandate?: string;
  format: "table" | "json";
  pageSize?: number;
  compare: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const fromEnv = parseRpcList(process.env.VETO_RPC);
  const out: Args = {
    rpc: fromEnv.length > 0 ? fromEnv.join(",") : DEFAULT_RPC,
    program: process.env.VETO_PROGRAM_ID ?? DEFAULT_PROGRAM_ID,
    mandate: process.env.VETO_MANDATE || undefined,
    format: "table",
    pageSize: process.env.VETO_PAGE_SIZE ? Number(process.env.VETO_PAGE_SIZE) : undefined,
    compare: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const next = () => argv[++i] ?? "";
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--rpc") {
      const value = next();
      const listed = parseRpcList(value);
      out.rpc = listed.length > 0 ? listed.join(",") : value;
    }
    else if (arg === "--program") out.program = next();
    else if (arg === "--mandate") out.mandate = next();
    else if (arg === "--page-size") out.pageSize = Number(next());
    else if (arg === "--format") {
      const value = next();
      if (value !== "table" && value !== "json") {
        throw new Error(`--format must be table or json, got ${value}`);
      }
      out.format = value;
    } else if (arg === "--json") out.format = "json";
    else if (arg === "--compare") out.compare = true;
    else if (arg.startsWith("-")) {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return out;
}

function usage(): string {
  return `veto-history: rebuild Paid and Refused decisions from program logs

Usage:
  veto-history [--rpc URL[,URL...]] [--program ID] [--mandate PDA] [--format table|json]
               [--page-size N] [--compare]

The on-chain ledger is a 32-entry ring. This command walks program signatures
(and falls back to block scan when the RPC has no signature index) and decodes
Anchor Paid and Refused events. It does not invent rows for gaps.

--compare reads the ring for --mandate and checks that every paid/refused
entry still in the ring matches an indexer row on amount, nonce, counterparty,
kind, reason and suggested override.
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const result = await fetchDecisionHistory({
    rpcUrl: args.rpc,
    programId: args.program,
    mandate: args.mandate,
    pageSize: args.pageSize,
  });

  if (args.format === "json") {
    const body: Record<string, unknown> = {
      rpc: args.rpc,
      program: args.program,
      mandate: args.mandate ?? null,
      signature_pages: result.signaturePages,
      signature_count: result.signatureCount,
      used_block_scan: result.usedBlockScan,
      slots_scanned: result.slotsScanned,
      decisions: result.decisions.map(decisionToJson),
    };
    if (args.compare) {
      if (!args.mandate) throw new Error("--compare requires --mandate");
      const program = new PublicKey(args.program);
      const mandate = new PublicKey(args.mandate);
      const ring = await fetchLedgerRing(args.rpc, program, mandate);
      const cmp = compareRingToHistory(ring.entries, result.decisions);
      body.ring = {
        address: ring.address,
        total: ring.total,
        head: ring.head,
        occupancy: ring.entries.length,
      };
      body.comparison = {
        ok: cmp.ok,
        ring_decisions: cmp.ringDecisions,
        matched: cmp.matched,
        extra_in_indexer: cmp.extraInIndexer.length,
        rows: cmp.rows.map((row) => ({
          equal: row.equal,
          diffs: row.diffs,
          ring: {
            ts: row.ring.ts.toString(),
            amount: row.ring.amount.toString(),
            nonce: row.ring.nonce.toString(),
            counterparty: row.ring.counterparty,
            kind: row.ring.kindName,
            reason: row.ring.reason,
            suggested_override: row.ring.suggestedOverride.toString(),
          },
          indexed: row.indexed ? decisionToJson(row.indexed) : null,
        })),
      };
    }
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    if (args.compare && body.comparison && (body.comparison as { ok: boolean }).ok === false) {
      process.exitCode = 1;
    }
    return;
  }

  process.stdout.write(
    `rpc ${args.rpc}\nprogram ${args.program}\n` +
      `signatures ${result.signatureCount} across ${result.signaturePages} page(s)` +
      `${result.usedBlockScan ? ` (signature index empty, scanned ${result.slotsScanned} slots)` : ""}\n` +
      `${result.decisions.length} Paid/Refused event(s)\n\n`,
  );
  process.stdout.write(`${formatTable(result.decisions)}\n`);

  if (args.compare) {
    if (!args.mandate) throw new Error("--compare requires --mandate");
    const program = new PublicKey(args.program);
    const mandate = new PublicKey(args.mandate);
    const ring = await fetchLedgerRing(args.rpc, program, mandate);
    const cmp = compareRingToHistory(ring.entries, result.decisions);
    process.stdout.write(
      `\nring ${ring.address} total=${ring.total} head=${ring.head} occupancy=${ring.entries.length}\n`,
    );
    process.stdout.write(`${formatComparison(cmp)}\n`);
    if (!cmp.ok) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
