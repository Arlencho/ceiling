import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchDecisionHistory } from "../indexer/src/index.js";
import {
  bundleToCsv,
  bundleToJson,
  buildRecordFromIndexed,
  buildScope,
  filterIndexed,
  inferFormat,
  makeBundle,
  overlayRing,
  parseTimeBound,
  type IndexedDecision,
} from "./bulk.js";
import {
  buildRecord,
  connection,
  entryMatches,
  fetchLedger,
  fetchMandate,
  flagString,
  indexedEntries,
  kindByte,
  ledgerPda,
  parseArgs,
  parseChargeFromTx,
  parseChargeLogs,
  recordToJson,
  resolveClusterName,
  resolveProgramId,
  resolveRpcList,
  type DecisionRecord,
  type LedgerAccount,
  type LedgerEntry,
  type MandateAccount,
} from "./lib.js";

function usage(): never {
  console.error(`export a Veto decision as JSON, or a population as JSON or CSV

Usage:
  npx tsx export.ts --signature <tx> [--out file] [--rpc url[,url...]]
  npx tsx export.ts --mandate <addr> [--kind paid|refused] [--format json|csv] [--out file] [--rpc url[,url...]]
  npx tsx export.ts --from <when> --to <when> [--mandate <addr>] [--format json|csv] [--out file] [--rpc url[,url...]]

--signature writes one version-1 record (the demo beat).
--mandate writes everything under that rule.
--from / --to writes the date range (UTC calendar day or unix seconds). Combine with
--mandate to bound one rule.

Bulk rows come from the indexer (transaction logs), not the 32-entry on-chain ring.
A long range is otherwise silently incomplete once the ring wraps. Default includes
paid and refused. The file states completeness=payments: complete over charges that
landed on chain, never over attempts.

--format json (default) or csv. A .csv --out infers csv.
--page-size N and --block-scan are passed through to the indexer. Block scan
is off by default (public RPC has a signature index; a local validator may
need it).
Export does not need a keypair. It re-reads the cluster.
`);
  process.exit(2);
}

async function getTx(conn: Connection, signature: string) {
  const tx = await conn.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    throw new Error(
      `transaction ${signature} not found on this RPC (wrong cluster, or history pruned)`,
    );
  }
  return tx;
}

async function recordFromSignature(
  conn: Connection,
  signature: string,
  programId: PublicKey,
  cluster: string,
  genesisHash: string,
) {
  const tx = await getTx(conn, signature);
  if (tx.meta?.err) {
    throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(tx.meta.err)}`);
  }
  const charge = parseChargeFromTx(tx, programId);
  if (!charge) {
    throw new Error(`transaction ${signature} does not invoke charge on ${programId.toBase58()}`);
  }
  const mandateAccount = await fetchMandate(conn, charge.mandate);
  const ledgerAddress = ledgerPda(programId, charge.mandate);
  if (!charge.ledger.equals(ledgerAddress)) {
    throw new Error("charge ledger account does not match the PDA derived from the mandate");
  }
  const ledger = await fetchLedger(conn, ledgerAddress);
  const wantKind = (() => {
    const logs = parseChargeLogs(tx.meta?.logMessages ?? []);
    if (logs) return kindByte(logs.kind);
    return null;
  })();
  const matches = indexedEntries(ledger).filter((row) =>
    entryMatches(row.entry, {
      amount: charge.amount,
      nonce: charge.nonce,
      kind: wantKind ?? row.entry.kind,
    }),
  );
  let entry: LedgerEntry;
  if (matches.length === 1) {
    entry = matches[0]!.entry;
  } else if (matches.length > 1) {
    const logs = parseChargeLogs(tx.meta?.logMessages ?? []);
    const blockTime = tx.blockTime !== null && tx.blockTime !== undefined ? BigInt(tx.blockTime) : null;
    const scored = matches
      .map((row) => {
        let score = 0;
        if (blockTime !== null && row.entry.ts === blockTime) score += 2;
        if (logs && row.entry.reason === logs.reasonCode) score += 2;
        if (logs && row.entry.suggestedOverride === logs.suggestedOverride) score += 1;
        return { row, score };
      })
      .sort((a, b) => b.score - a.score);
    entry = scored[0]!.row.entry;
  } else {
    const logs = parseChargeLogs(tx.meta?.logMessages ?? []);
    if (!logs) {
      throw new Error(
        "no matching ledger row and the transaction logs have neither PAID nor REFUSED",
      );
    }
    entry = {
      ts: tx.blockTime !== null && tx.blockTime !== undefined ? BigInt(tx.blockTime) : 0n,
      amount: charge.amount,
      counterparty: charge.destination,
      nonce: charge.nonce,
      suggestedOverride: logs.suggestedOverride,
      kind: kindByte(logs.kind),
      reason: logs.reasonCode,
    };
    console.error("warning: ledger ring no longer holds this decision; reconstructed from the transaction");
  }
  return buildRecord({
    cluster,
    genesisHash,
    programId,
    mandate: charge.mandate,
    mandateAccount,
    entry,
    signature,
  });
}

async function recordsFromIndexer(args: {
  conn: Connection;
  rpc: string;
  programId: PublicKey;
  cluster: string;
  genesisHash: string;
  mandate?: string;
  from?: number | null;
  to?: number | null;
  kind?: "paid" | "refused";
  nonce?: bigint;
  pageSize?: number;
  allowBlockScan: boolean;
}): Promise<DecisionRecord[]> {
  const history = await fetchDecisionHistory({
    rpcUrl: args.rpc,
    programId: args.programId.toBase58(),
    mandate: args.mandate,
    pageSize: args.pageSize,
    allowBlockScan: args.allowBlockScan,
  });
  const filtered = filterIndexed(history.decisions as IndexedDecision[], {
    mandate: args.mandate,
    from: args.from,
    to: args.to,
    kind: args.kind,
    nonce: args.nonce,
  });
  const mandates = new Map<string, MandateAccount>();
  const ledgers = new Map<string, LedgerAccount | null>();
  const records: DecisionRecord[] = [];
  for (const decision of filtered) {
    if (!mandates.has(decision.mandate)) {
      const pk = new PublicKey(decision.mandate);
      mandates.set(decision.mandate, await fetchMandate(args.conn, pk));
      try {
        ledgers.set(decision.mandate, await fetchLedger(args.conn, ledgerPda(args.programId, pk)));
      } catch {
        ledgers.set(decision.mandate, null);
      }
    }
    const mandateAccount = mandates.get(decision.mandate)!;
    const ledger = ledgers.get(decision.mandate) ?? null;
    records.push(
      buildRecordFromIndexed({
        cluster: args.cluster,
        genesisHash: args.genesisHash,
        programId: args.programId,
        mandateAccount,
        decision,
        ringEntry: overlayRing(ledger, decision),
      }),
    );
  }
  return records;
}

function writeOutput(text: string, out: string | undefined): void {
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.error(`wrote ${out}`);
  }
  process.stdout.write(text);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.flags.help || cli.flags.h) usage();
  const rpcs = resolveRpcList(cli);
  const rpc = rpcs.join(",");
  const programId = resolveProgramId();
  const cluster = resolveClusterName();
  const conn = connection(rpcs);
  const genesisHash = await conn.getGenesisHash();

  const signature = flagString(cli, "signature");
  const mandateStr = flagString(cli, "mandate");
  const kindStr = flagString(cli, "kind");
  const nonceStr = flagString(cli, "nonce");
  const fromStr = flagString(cli, "from");
  const toStr = flagString(cli, "to");
  const out = flagString(cli, "out");
  const format = inferFormat(out, flagString(cli, "format"));
  const pageSizeStr = flagString(cli, "page-size");
  const pageSize = pageSizeStr !== undefined ? Number(pageSizeStr) : undefined;
  const allowBlockScan = cli.flags["block-scan"] === true;

  if (kindStr !== undefined && kindStr !== "paid" && kindStr !== "refused") {
    throw new Error("--kind must be paid or refused");
  }
  const kindFilter: "paid" | "refused" | undefined =
    kindStr === "paid" || kindStr === "refused" ? kindStr : undefined;
  const nonce = nonceStr !== undefined ? BigInt(nonceStr) : undefined;
  const from = fromStr !== undefined ? parseTimeBound(fromStr, false) : undefined;
  const to = toStr !== undefined ? parseTimeBound(toStr, true) : undefined;

  if (signature) {
    const record = await recordFromSignature(conn, signature, programId, cluster, genesisHash);
    if (format === "csv") {
      const bundle = makeBundle({
        cluster,
        genesisHash,
        programId: programId.toBase58(),
        scope: buildScope({ mandate: record.mandate }),
        decisions: [record],
      });
      writeOutput(bundleToCsv(bundle), out);
      return;
    }
    writeOutput(recordToJson(record), out);
    return;
  }

  if (!mandateStr && from === undefined && to === undefined) usage();

  const records = await recordsFromIndexer({
    conn,
    rpc,
    programId,
    cluster,
    genesisHash,
    mandate: mandateStr,
    from: from ?? null,
    to: to ?? null,
    kind: kindFilter,
    nonce,
    pageSize,
    allowBlockScan,
  });
  const bundle = makeBundle({
    cluster,
    genesisHash,
    programId: programId.toBase58(),
    scope: buildScope({
      mandate: mandateStr,
      from: from ?? null,
      to: to ?? null,
    }),
    decisions: records,
  });
  console.error(
    `export ${records.length} decision(s) completeness=${bundle.completeness} scope=${bundle.scope.type}`,
  );
  writeOutput(format === "csv" ? bundleToCsv(bundle) : bundleToJson(bundle), out);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`export failed: ${message}`);
  process.exit(1);
});
