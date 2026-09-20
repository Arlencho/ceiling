import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import {
  REPO_DIR,
  buildRecord,
  connection,
  entryMatches,
  fetchLedger,
  fetchMandate,
  flagString,
  indexedEntries,
  kindByte,
  kindName,
  ledgerPda,
  parseArgs,
  parseChargeFromTx,
  parseChargeLogs,
  recordToJson,
  resolveClusterName,
  resolveProgramId,
  resolveRpc,
  type LedgerEntry,
} from "./lib.js";

function usage(): never {
  console.error(`export a Veto decision as JSON

Usage:
  npx tsx export.ts --signature <tx> [--out file] [--rpc url]
  npx tsx export.ts --mandate <addr> [--kind paid|refused] [--nonce n] [--out file] [--rpc url]

The record is written to stdout. --out also writes the same JSON to a file.
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

async function findSignatureForEntry(
  conn: Connection,
  mandate: PublicKey,
  programId: PublicKey,
  entry: LedgerEntry,
): Promise<string> {
  let before: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const opts: { limit: number; before?: string } = { limit: 1000 };
    if (before) opts.before = before;
    const sigs: ConfirmedSignatureInfo[] = await conn.getSignaturesForAddress(mandate, opts, "confirmed");
    if (sigs.length === 0) break;
    for (const info of sigs) {
      if (info.err) continue;
      const tx = await conn.getTransaction(info.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) continue;
      const charge = parseChargeFromTx(tx, programId);
      if (!charge) continue;
      if (!charge.mandate.equals(mandate)) continue;
      if (charge.amount !== entry.amount || charge.nonce !== entry.nonce) continue;
      const logs = parseChargeLogs(tx.meta?.logMessages ?? []);
      const kind = logs ? kindName(kindByte(logs.kind)) : kindName(entry.kind);
      if (kind !== kindName(entry.kind)) continue;
      if (logs && logs.reasonCode !== entry.reason) continue;
      return info.signature;
    }
    before = sigs[sigs.length - 1]!.signature;
    if (sigs.length < 1000) break;
  }
  throw new Error(
    "could not recover a transaction signature for this ledger entry; pass --signature, and check the cluster retains history",
  );
}

async function recordFromMandate(
  conn: Connection,
  mandate: PublicKey,
  programId: PublicKey,
  cluster: string,
  genesisHash: string,
  kindFilter: "paid" | "refused" | undefined,
  nonceFilter: bigint | undefined,
) {
  const mandateAccount = await fetchMandate(conn, mandate);
  const ledger = await fetchLedger(conn, ledgerPda(programId, mandate));
  const rows = indexedEntries(ledger)
    .filter((row) => kindName(row.entry.kind) !== null)
    .filter((row) => (kindFilter ? kindName(row.entry.kind) === kindFilter : true))
    .filter((row) => (nonceFilter !== undefined ? row.entry.nonce === nonceFilter : true));
  if (rows.length === 0) {
    throw new Error("no paid/refused ledger entry matches the filters");
  }
  const chosen = rows[rows.length - 1]!;
  const signature = await findSignatureForEntry(conn, mandate, programId, chosen.entry);
  return buildRecord({
    cluster,
    genesisHash,
    programId,
    mandate,
    mandateAccount,
    entry: chosen.entry,
    signature,
  });
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.flags.help || cli.flags.h) usage();
  const rpc = resolveRpc(cli);
  const programId = resolveProgramId();
  const cluster = resolveClusterName();
  const conn = connection(rpc);
  const genesisHash = await conn.getGenesisHash();

  const signature = flagString(cli, "signature");
  const mandateStr = flagString(cli, "mandate");
  const kindStr = flagString(cli, "kind");
  const nonceStr = flagString(cli, "nonce");
  const out = flagString(cli, "out");

  if (kindStr !== undefined && kindStr !== "paid" && kindStr !== "refused") {
    throw new Error("--kind must be paid or refused");
  }
  const kindFilter: "paid" | "refused" | undefined =
    kindStr === "paid" || kindStr === "refused" ? kindStr : undefined;
  const nonce = nonceStr !== undefined ? BigInt(nonceStr) : undefined;

  let record;
  if (signature) {
    record = await recordFromSignature(conn, signature, programId, cluster, genesisHash);
  } else if (mandateStr) {
    record = await recordFromMandate(
      conn,
      new PublicKey(mandateStr),
      programId,
      cluster,
      genesisHash,
      kindFilter,
      nonce,
    );
  } else {
    usage();
  }

  const json = recordToJson(record);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
    console.error(`wrote ${out}`);
  }
  process.stdout.write(json);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`export failed: ${message}`);
  process.exit(1);
});
