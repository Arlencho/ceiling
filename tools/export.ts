import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchDecisionHistory } from "../indexer/src/index.js";
import { isTransportError } from "../indexer/src/rpc.js";
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
  bindByTriple,
  boundVetoDecision,
  buildRecord,
  connection,
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
  ringEntryForSignature,
  ringRowForLogKind,
  type DecisionRecord,
  type DecisionTriple,
  type LedgerAccount,
  type LedgerEntry,
  type MandateAccount,
  type OpenedMandate,
} from "./lib.js";
import {
  CLOSED_MANDATE_LIMITS_NOTE,
  coveredOpeningTenures,
  openingTenureForSignature,
  tenureCovering,
} from "./verify.js";

function usage(): never {
  console.error(`export a Veto decision as JSON, or a population as JSON or CSV

Usage:
  npx tsx export.ts --signature <tx> [--out file] [--rpc url[,url...]]
  npx tsx export.ts --mandate <addr> [--kind paid|refused] [--format json|csv] [--out file] [--rpc url[,url...]]
  npx tsx export.ts --from <when> --to <when> [--mandate <addr>] [--format json|csv] [--out file] [--rpc url[,url...]]

--signature writes one version-1 record (the demo beat).
A transaction with more than one charge also needs --mandate, --nonce, and --amount.
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

export async function recordFromSignature(
  conn: Connection,
  signature: string,
  programId: PublicKey,
  cluster: string,
  genesisHash: string,
  want?: DecisionTriple,
) {
  const tx = await getTx(conn, signature);
  if (tx.meta?.err) {
    throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(tx.meta.err)}`);
  }
  const charges = parseChargeFromTx(tx, programId);
  if (charges.length === 0) {
    throw new Error(`transaction ${signature} does not invoke charge on ${programId.toBase58()}`);
  }
  let charge;
  if (want) {
    const matched = bindByTriple(charges, want, (item) => ({
      mandate: item.mandate.toBase58(),
      nonce: item.nonce,
      amount: item.amount,
    }));
    if (matched.length !== 1) {
      throw new Error(
        `transaction ${signature} carries ${matched.length} charges matching mandate, nonce, and amount`,
      );
    }
    charge = matched[0]!;
  } else if (charges.length === 1) {
    charge = charges[0]!;
  } else {
    throw new Error(
      `transaction ${signature} carries ${charges.length} charges; pass mandate, nonce, and amount`,
    );
  }
  let mandateAccount: {
    cap: bigint;
    perTxMax: bigint;
    expiresAt: bigint;
    merchant: PublicKey;
    purpose: string;
  };
  let fromOpening = false;
  try {
    mandateAccount = await fetchMandate(conn, charge.mandate);
  } catch (err) {
    if (isTransportError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("mandate account not found")) throw err;
    mandateAccount = await openingTenureForSignature(conn, programId, charge.mandate, signature);
    fromOpening = true;
  }
  const ledgerAddress = ledgerPda(programId, charge.mandate);
  if (!charge.ledger.equals(ledgerAddress)) {
    throw new Error("charge ledger account does not match the PDA derived from the mandate");
  }
  let ledger: LedgerAccount | null = null;
  try {
    ledger = await fetchLedger(conn, ledgerAddress);
  } catch (err) {
    if (isTransportError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!(fromOpening && message.startsWith("ledger account not found"))) throw err;
  }
  // Same candidate set verify uses: mandate, nonce, and amount. Log kind is not
  // a filter. Two rows can share a nonce when a refusal does not advance it.
  const ringWant = {
    mandate: charge.mandate.toBase58(),
    nonce: charge.nonce,
    amount: charge.amount,
  };
  const held = ledger;
  const matches = held
    ? bindByTriple(indexedEntries(held), ringWant, (row) => ({
        mandate: held.mandate.toBase58(),
        nonce: row.entry.nonce,
        amount: row.entry.amount,
      }))
    : [];
  const logMessages = tx.meta?.logMessages ?? [];
  const bound = boundVetoDecision(logMessages, programId, ringWant);
  let entry: LedgerEntry;
  if (!held) {
    if (bound.status === "error") throw new Error(bound.error);
    if (bound.status === "none") {
      throw new Error(
        "no matching ledger row and the transaction logs have neither PAID nor REFUSED",
      );
    }
    entry = {
      ts: tx.blockTime !== null && tx.blockTime !== undefined ? BigInt(tx.blockTime) : 0n,
      amount: charge.amount,
      counterparty: charge.destination,
      nonce: charge.nonce,
      suggestedOverride: bound.decision.suggestedOverride,
      kind: kindByte(bound.decision.kind),
      reason: bound.decision.reasonCode,
    };
    console.error("warning: ledger ring no longer holds this decision; reconstructed from the transaction");
  } else if (matches.length === 0) {
    const logs = parseChargeLogs(logMessages, programId);
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
  } else if (bound.status === "error") {
    throw new Error(bound.error);
  } else {
    const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;
    const timePick = ringEntryForSignature(matches, blockTime, signature);
    const logKind = bound.status === "one" ? kindByte(bound.decision.kind) : null;
    const picked = ringRowForLogKind(timePick, matches, blockTime, signature, logKind);
    if ("error" in picked) {
      throw new Error(picked.error);
    }
    entry = picked.entry;
  }
  if (fromOpening) console.error(`note: ${CLOSED_MANDATE_LIMITS_NOTE}`);
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

export async function recordsFromIndexedDecisions(args: {
  conn: Connection;
  programId: PublicKey;
  cluster: string;
  genesisHash: string;
  decisions: readonly IndexedDecision[];
}): Promise<DecisionRecord[]> {
  const live = new Map<string, MandateAccount>();
  const closed = new Map<string, Map<string, OpenedMandate>>();
  const ledgers = new Map<string, LedgerAccount | null>();
  const records: DecisionRecord[] = [];
  for (const decision of args.decisions) {
    const pk = new PublicKey(decision.mandate);
    let mandateAccount: {
      cap: bigint;
      perTxMax: bigint;
      expiresAt: bigint;
      merchant: PublicKey;
      purpose: string;
    };
    let fromOpening = false;
    const cached = live.get(decision.mandate);
    if (cached) {
      mandateAccount = cached;
    } else {
      const knownClosed = closed.get(decision.mandate);
      if (knownClosed) {
        mandateAccount = tenureCovering(knownClosed, decision.signature);
        fromOpening = true;
      } else {
        try {
          const account = await fetchMandate(args.conn, pk);
          live.set(decision.mandate, account);
          mandateAccount = account;
        } catch (err) {
          if (isTransportError(err)) throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (!message.startsWith("mandate account not found")) throw err;
          const covered = await coveredOpeningTenures(args.conn, args.programId, pk);
          closed.set(decision.mandate, covered);
          mandateAccount = tenureCovering(covered, decision.signature);
          fromOpening = true;
        }
      }
    }
    if (!ledgers.has(decision.mandate)) {
      try {
        ledgers.set(decision.mandate, await fetchLedger(args.conn, ledgerPda(args.programId, pk)));
      } catch {
        ledgers.set(decision.mandate, null);
      }
    }
    if (fromOpening) console.error(`note: ${CLOSED_MANDATE_LIMITS_NOTE}`);
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
  return recordsFromIndexedDecisions({
    conn: args.conn,
    programId: args.programId,
    cluster: args.cluster,
    genesisHash: args.genesisHash,
    decisions: filtered,
  });
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
    const amountStr = flagString(cli, "amount");
    let want: DecisionTriple | undefined;
    if (mandateStr !== undefined || nonce !== undefined || amountStr !== undefined) {
      if (mandateStr === undefined || nonce === undefined || amountStr === undefined) {
        throw new Error("--signature needs --mandate, --nonce, and --amount together");
      }
      want = { mandate: mandateStr, nonce, amount: BigInt(amountStr) };
    }
    const record = await recordFromSignature(conn, signature, programId, cluster, genesisHash, want);
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

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`export failed: ${message}`);
    process.exit(1);
  });
}
