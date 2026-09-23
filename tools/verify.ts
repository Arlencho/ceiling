import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchDecisionHistory } from "../indexer/src/index.js";
import {
  COMPLETENESS,
  filterIndexed,
  formatBulkReport,
  parseExportText,
  type DecisionBundle,
  type RowVerdict,
} from "./bulk.js";
import {
  KIND_PAID,
  KIND_REFUSED,
  REPO_DIR,
  clusterForGenesis,
  connection,
  fetchLedger,
  fetchMandate,
  flagString,
  indexedEntries,
  ledgerPda,
  parseArgs,
  parseChargeFromTx,
  parseChargeLogs,
  reasonText,
  redactRpcUrls,
  resolveRpcList,
  resolveVerifyProgramId,
  ringEntryForSignature,
  tokenAccountOwner,
  type DecisionRecord,
  type LedgerEntry,
  type MandateAccount,
} from "./lib.js";

export type Verdict = {
  ok: boolean;
  failures: string[];
  text: string;
};

export type AssessOpts = {
  env?: NodeJS.ProcessEnv;
  programId?: PublicKey;
  allowBlockScan?: boolean;
  pageSize?: number;
};

function usage(): never {
  console.error(`verify a Veto decision record against the chain

Usage:
  npx tsx verify.ts <file.json|file.csv> [--rpc url[,url...]] [--program-id <pubkey>]
  npx tsx export.ts --signature <tx> | npx tsx verify.ts
  npx tsx export.ts --mandate <addr> | npx tsx verify.ts

A single version-1 JSON object prints one verdict.
A bulk JSON bundle or CSV prints how many rows were confirmed and names every
row that was not, with the reason. The verdict also prints the scope, program,
cluster, mandate, and range it checked. Exit 0 only when every row confirms.
A rule export must also contain every paid and refused ledger row once.
A date_range export must match the indexer's signature set for that range
(the whole program, when the scope names no mandate). --page-size and
--block-scan are passed through to the indexer. Block scan is off unless
--block-scan is set.

Exit 0 on CONFIRMED, 1 on REJECTED, 2 on usage error.
Does not need a keypair. Re-reads the cluster independently of the phone.
The program id is the address in tools/idl/veto.json
(3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV) unless --program-id or
VETO_PROGRAM_ID is set. keys/devnet-addresses.env is not read.
The program_id in the file is not used.
`);
  process.exit(2);
}

function readInput(path: string | undefined): string {
  if (!path || path === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(path, "utf8");
}

function fail(failures: string[]): never {
  console.log("VERDICT: REJECTED");
  console.log("");
  for (const line of failures) {
    console.log(`- ${line}`);
  }
  process.exit(1);
}

function eq(a: bigint | string | number, b: bigint | string | number, field: string, failures: string[]): void {
  if (a.toString() !== b.toString()) {
    failures.push(`${field}: record has ${a}, chain has ${b}`);
  }
}

type CheckCache = {
  conn: Connection;
  expectedProgramId: PublicKey;
  programSource: string;
  rpc: string;
  allowBlockScan: boolean;
  pageSize?: number;
  genesis?: string;
  mandates: Map<string, MandateAccount>;
  ledgers: Map<string, Awaited<ReturnType<typeof fetchLedger>>>;
  destOwners: Map<string, PublicKey>;
  txs: Map<string, Awaited<ReturnType<Connection["getTransaction"]>>>;
};

function txBlockTime(tx: { blockTime?: number | null }): number | null {
  return typeof tx.blockTime === "number" ? tx.blockTime : null;
}

function recordKey(record: DecisionRecord): string {
  return [
    record.kind,
    record.nonce.toString(),
    record.timestamp.toString(),
    record.amount.toString(),
    record.counterparty,
    String(record.reason_code),
    record.suggested_override.toString(),
  ].join("|");
}

function entryKey(entry: LedgerEntry): string {
  const kind = entry.kind === KIND_PAID ? "paid" : "refused";
  return [
    kind,
    entry.nonce.toString(),
    entry.ts.toString(),
    entry.amount.toString(),
    entry.counterparty.toBase58(),
    String(entry.reason),
    entry.suggestedOverride.toString(),
  ].join("|");
}

function describeKey(key: string): string {
  const [kind, nonce, timestamp, amount] = key.split("|");
  return `${kind} amount=${amount} nonce=${nonce} timestamp=${timestamp}`;
}

function times(n: number): string {
  return `${n} ${n === 1 ? "time" : "times"}`;
}

function shownRpc(rpc: string): string {
  return redactRpcUrls(
    rpc
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

function programChoice(opts?: AssessOpts): { programId: PublicKey; source: string } {
  if (opts?.programId) return { programId: opts.programId, source: "flag" };
  const resolved = resolveVerifyProgramId(REPO_DIR, opts?.env ?? process.env);
  return { programId: resolved.programId, source: resolved.source };
}

async function checkRecord(
  record: DecisionRecord,
  rpc: string,
  cache: CheckCache,
): Promise<{ failures: string[]; notes: string[] }> {
  const failures: string[] = [];
  const notes: string[] = [];
  const conn = cache.conn;
  const programId = cache.expectedProgramId;
  if (record.program_id !== programId.toBase58()) {
    failures.push(
      `program_id: record has ${record.program_id}, this tool checks ${programId.toBase58()}`,
    );
    return { failures, notes };
  }
  const mandatePk = new PublicKey(record.mandate);

  const genesis = cache.genesis ?? (cache.genesis = await conn.getGenesisHash());
  eq(record.genesis_hash, genesis, "genesis_hash", failures);
  const derivedCluster = clusterForGenesis(genesis);
  if (record.cluster !== derivedCluster) {
    failures.push(`cluster: record has ${record.cluster}, genesis ${genesis} is ${derivedCluster}`);
  }

  if (record.reason_text !== reasonText(record.reason_code)) {
    failures.push(
      `reason_text: record has "${record.reason_text}", canonical text for code ${record.reason_code} is "${reasonText(record.reason_code)}"`,
    );
  }
  if (record.kind === "paid" && record.reason_code !== 0) {
    failures.push(`kind is paid but reason_code is ${record.reason_code}`);
  }
  if (record.kind === "refused" && record.reason_code === 0) {
    failures.push("kind is refused but reason_code is 0 (ok)");
  }
  if (reasonText(record.reason_code) === "unknown") {
    failures.push(`reason_code ${record.reason_code} is not a code the program emits`);
  }

  const tx = await cachedTransaction(cache, record.signature);
  if (!tx) {
    failures.push(
      `signature ${record.signature} not found on ${shownRpc(rpc)} (wrong cluster, tampered signature, or history pruned)`,
    );
    return { failures, notes };
  }
  if (tx.meta?.err) {
    failures.push(`transaction failed on chain: ${JSON.stringify(tx.meta.err)}`);
  }

  const charge = parseChargeFromTx(tx, programId);
  if (!charge) {
    failures.push(`transaction does not invoke charge on ${programId.toBase58()}`);
    return { failures, notes };
  }
  eq(record.amount, charge.amount, "amount (instruction)", failures);
  eq(record.nonce, charge.nonce, "nonce (instruction)", failures);
  eq(record.mandate, charge.mandate.toBase58(), "mandate (instruction)", failures);
  eq(record.counterparty, charge.destination.toBase58(), "counterparty (destination)", failures);

  const expectedLedger = ledgerPda(programId, mandatePk);
  eq(charge.ledger.toBase58(), expectedLedger.toBase58(), "ledger PDA", failures);

  let mandate = cache.mandates.get(record.mandate);
  if (!mandate) {
    mandate = await fetchMandate(conn, mandatePk);
    cache.mandates.set(record.mandate, mandate);
  }
  eq(record.limits.cap, mandate.cap, "limits.cap", failures);
  eq(record.limits.per_tx_max, mandate.perTxMax, "limits.per_tx_max", failures);
  eq(record.limits.expires_at, mandate.expiresAt, "limits.expires_at", failures);
  eq(record.limits.merchant, mandate.merchant.toBase58(), "limits.merchant", failures);
  if (record.limits.purpose !== mandate.purpose) {
    failures.push(`limits.purpose: record has "${record.limits.purpose}", chain has "${mandate.purpose}"`);
  }
  const idLe = Buffer.alloc(8);
  idLe.writeBigUInt64LE(mandate.mandateId);
  const derived = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), mandate.owner.toBuffer(), idLe],
    programId,
  )[0];
  if (!derived.equals(mandatePk)) {
    failures.push(
      `mandate PDA re-derived from on-chain owner+mandate_id is ${derived.toBase58()}, record has ${record.mandate}`,
    );
  }

  let destOwner = cache.destOwners.get(charge.destination.toBase58());
  if (!destOwner) {
    destOwner = await tokenAccountOwner(conn, charge.destination);
    cache.destOwners.set(charge.destination.toBase58(), destOwner);
  }
  if (!destOwner.equals(mandate.merchant)) {
    failures.push(
      `destination token account owner is ${destOwner.toBase58()}, mandate merchant is ${mandate.merchant.toBase58()}`,
    );
  }

  const ledgerKey = expectedLedger.toBase58();
  let ledger = cache.ledgers.get(ledgerKey);
  if (!ledger) {
    ledger = await fetchLedger(conn, expectedLedger);
    cache.ledgers.set(ledgerKey, ledger);
  }
  if (!ledger.mandate.equals(mandatePk)) {
    failures.push(`ledger.mandate is ${ledger.mandate.toBase58()}, expected ${record.mandate}`);
  }
  const rows = indexedEntries(ledger).filter((row) => row.entry.nonce === record.nonce);
  const logs = parseChargeLogs(tx.meta?.logMessages ?? [], programId);
  const blockTime = txBlockTime(tx);
  if (rows.length === 0) {
    if (!logs) {
      failures.push("ledger ring has no matching row and transaction logs have neither PAID nor REFUSED");
    } else {
      notes.push("ledger ring no longer holds this decision; checking transaction logs");
      eq(record.kind, logs.kind, "kind (logs)", failures);
      eq(record.reason_code, logs.reasonCode, "reason_code (logs)", failures);
      eq(record.amount, logs.amount, "amount (logs)", failures);
      eq(record.suggested_override, logs.suggestedOverride, "suggested_override (logs)", failures);
      if (record.reason_text !== logs.reasonText) {
        failures.push(`reason_text: record has "${record.reason_text}", logs have "${logs.reasonText}"`);
      }
      if (blockTime !== null) {
        eq(record.timestamp, BigInt(blockTime), "timestamp (transaction)", failures);
      }
    }
  } else {
    const picked = ringEntryForSignature(rows, blockTime, record.signature);
    if ("error" in picked) {
      failures.push(picked.error);
    } else {
      const entry = picked.entry;
      eq(record.amount, entry.amount, "amount (ledger)", failures);
      eq(record.nonce, entry.nonce, "nonce (ledger)", failures);
      eq(record.timestamp, entry.ts, "timestamp (ledger)", failures);
      eq(record.counterparty, entry.counterparty.toBase58(), "counterparty (ledger)", failures);
      eq(record.suggested_override, entry.suggestedOverride, "suggested_override (ledger)", failures);
      eq(record.reason_code, entry.reason, "reason_code (ledger)", failures);
      const chainKind = entry.kind === 1 ? "paid" : entry.kind === 2 ? "refused" : String(entry.kind);
      eq(record.kind, chainKind, "kind (ledger)", failures);
    }
  }

  if (logs) {
    eq(record.kind, logs.kind, "kind (logs)", failures);
    eq(record.reason_code, logs.reasonCode, "reason_code (logs)", failures);
  }

  return { failures, notes };
}

function confirmedLines(record: DecisionRecord, rpc: string, genesis: string, programSource: string): string[] {
  return [
    "VERDICT: CONFIRMED",
    "",
    `rpc                 ${shownRpc(rpc)}`,
    `cluster             ${clusterForGenesis(genesis)}`,
    `genesis_hash        ${genesis}`,
    `program_id          ${record.program_id}`,
    `checked against program ${record.program_id} (${programSource})`,
    `mandate             ${record.mandate}`,
    `signature           ${record.signature}`,
    `kind                ${record.kind}`,
    `amount              ${record.amount.toString()}`,
    `counterparty        ${record.counterparty}`,
    `timestamp           ${record.timestamp.toString()}`,
    `nonce               ${record.nonce.toString()}`,
    `reason              ${record.reason_code} (${record.reason_text})`,
    `suggested_override  ${record.suggested_override.toString()}`,
    `limits              cap=${record.limits.cap.toString()} per_tx_max=${record.limits.per_tx_max.toString()} expires_at=${record.limits.expires_at.toString()}`,
    `merchant            ${record.limits.merchant}`,
    `purpose             ${record.limits.purpose}`,
    "",
    "Mandate limits, ledger entry, and charge transaction agree.",
  ];
}

function rejectedText(failures: string[], notes: string[] = []): string {
  const lines = [...notes.map((note) => `note: ${note}`), "VERDICT: REJECTED", ""];
  for (const line of failures) lines.push(`- ${line}`);
  return `${lines.join("\n")}\n`;
}

function inScope(ts: bigint, bundle: DecisionBundle): boolean {
  if (bundle.scope.type !== "date_range") return true;
  if (bundle.scope.from !== null && ts < BigInt(bundle.scope.from)) return false;
  if (bundle.scope.to !== null && ts > BigInt(bundle.scope.to)) return false;
  return true;
}

async function bundleFailures(bundle: DecisionBundle, cache: CheckCache): Promise<string[]> {
  const failures: string[] = [];
  const expected = cache.expectedProgramId.toBase58();
  if (bundle.program_id !== expected) {
    failures.push(`program_id: envelope has ${bundle.program_id}, this tool checks ${expected}`);
  }
  const genesis = cache.genesis ?? (cache.genesis = await cache.conn.getGenesisHash());
  if (bundle.genesis_hash !== genesis) {
    failures.push(`genesis_hash: envelope has ${bundle.genesis_hash}, chain has ${genesis}`);
  }
  const cluster = clusterForGenesis(genesis);
  if (bundle.cluster !== cluster) {
    failures.push(`cluster: envelope has ${bundle.cluster}, genesis ${genesis} is ${cluster}`);
  }
  const seen = new Set<string>();
  for (const record of bundle.decisions) {
    if (seen.has(record.signature)) {
      failures.push(`signature ${record.signature} appears more than once`);
    }
    seen.add(record.signature);
    if (record.program_id !== bundle.program_id) {
      failures.push(
        `program_id: row ${record.signature} has ${record.program_id}, envelope has ${bundle.program_id}`,
      );
    }
    if (record.genesis_hash !== bundle.genesis_hash) {
      failures.push(
        `genesis_hash: row ${record.signature} has ${record.genesis_hash}, envelope has ${bundle.genesis_hash}`,
      );
    }
    if (record.cluster !== bundle.cluster) {
      failures.push(`cluster: row ${record.signature} has ${record.cluster}, envelope has ${bundle.cluster}`);
    }
    if (bundle.scope.mandate && record.mandate !== bundle.scope.mandate) {
      failures.push(`mandate: row ${record.signature} has ${record.mandate}, scope has ${bundle.scope.mandate}`);
    }
  }
  if (bundle.scope.type === "rule") {
    failures.push(...(await rulePopulationFailures(bundle, cache)));
  } else {
    failures.push(...(await dateRangePopulationFailures(bundle, cache)));
  }
  return failures;
}

function mandatePubkey(mandate: string, failures: string[]): PublicKey | null {
  try {
    return new PublicKey(mandate);
  } catch {
    failures.push(`scope.mandate ${mandate} is not a pubkey`);
    return null;
  }
}

function missingAccountMessage(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("mandate account not found") || message.startsWith("ledger account not found")) {
    return message;
  }
  return null;
}

async function cachedMandate(cache: CheckCache, mandate: string, mandatePk: PublicKey): Promise<MandateAccount> {
  const cached = cache.mandates.get(mandate);
  if (cached) return cached;
  const loaded = await fetchMandate(cache.conn, mandatePk);
  cache.mandates.set(mandate, loaded);
  return loaded;
}

async function cachedLedger(cache: CheckCache, mandatePk: PublicKey) {
  const ledgerKey = ledgerPda(cache.expectedProgramId, mandatePk);
  const key = ledgerKey.toBase58();
  const cached = cache.ledgers.get(key);
  if (cached) return cached;
  const loaded = await fetchLedger(cache.conn, ledgerKey);
  cache.ledgers.set(key, loaded);
  return loaded;
}

async function rulePopulationFailures(bundle: DecisionBundle, cache: CheckCache): Promise<string[]> {
  const failures: string[] = [];
  if (!bundle.scope.mandate) {
    failures.push("rule scope names no mandate, so completeness cannot be checked against a ledger");
    return failures;
  }
  const mandatePk = mandatePubkey(bundle.scope.mandate, failures);
  if (!mandatePk) return failures;
  let mandate: MandateAccount;
  try {
    mandate = await cachedMandate(cache, bundle.scope.mandate, mandatePk);
  } catch (err) {
    const missing = missingAccountMessage(err);
    if (!missing) throw err;
    failures.push(missing);
    return failures;
  }
  let ledger: Awaited<ReturnType<typeof cachedLedger>>;
  try {
    ledger = await cachedLedger(cache, mandatePk);
  } catch (err) {
    const missing = missingAccountMessage(err);
    if (!missing) throw err;
    failures.push(missing);
    return failures;
  }
  const chainRows = indexedEntries(ledger).filter(
    (row) =>
      (row.entry.kind === KIND_PAID || row.entry.kind === KIND_REFUSED) && inScope(row.entry.ts, bundle),
  );
  const chainCounts = new Map<string, number>();
  for (const row of chainRows) {
    const key = entryKey(row.entry);
    chainCounts.set(key, (chainCounts.get(key) ?? 0) + 1);
  }
  const fileCounts = new Map<string, number>();
  for (const row of bundle.decisions) {
    const key = recordKey(row);
    fileCounts.set(key, (fileCounts.get(key) ?? 0) + 1);
  }
  for (const [key, chainCount] of chainCounts) {
    const fileCount = fileCounts.get(key) ?? 0;
    if (fileCount !== chainCount) {
      failures.push(
        `ledger row ${describeKey(key)} appears ${times(fileCount)} in the file and ${times(chainCount)} on the ledger`,
      );
    }
  }
  const paid = bundle.decisions.filter((row) => row.kind === "paid").length;
  const refused = bundle.decisions.filter((row) => row.kind === "refused").length;
  if (paid !== mandate.spendCount) {
    failures.push(`paid rows: file has ${paid}, mandate spend_count is ${mandate.spendCount}`);
  }
  if (refused !== mandate.refusalCount) {
    failures.push(`refused rows: file has ${refused}, mandate refusal_count is ${mandate.refusalCount}`);
  }
  return failures;
}

async function dateRangePopulationFailures(bundle: DecisionBundle, cache: CheckCache): Promise<string[]> {
  const failures: string[] = [];
  if (bundle.scope.mandate) {
    const mandatePk = mandatePubkey(bundle.scope.mandate, failures);
    if (!mandatePk) return failures;
    try {
      await cachedMandate(cache, bundle.scope.mandate, mandatePk);
    } catch (err) {
      const missing = missingAccountMessage(err);
      if (!missing) throw err;
      failures.push(missing);
      return failures;
    }
  }
  const history = await fetchDecisionHistory({
    rpcUrl: cache.rpc,
    programId: cache.expectedProgramId.toBase58(),
    mandate: bundle.scope.mandate ?? undefined,
    connection: cache.conn,
    allowBlockScan: cache.allowBlockScan,
    pageSize: cache.pageSize,
    from: bundle.scope.from,
    to: bundle.scope.to,
  });
  for (const [signature, fetched] of history.transactions) {
    cache.txs.set(signature, fetched);
  }
  const indexed = filterIndexed(history.decisions, {
    mandate: bundle.scope.mandate ?? undefined,
    from: bundle.scope.from,
    to: bundle.scope.to,
  });
  const population = new Set(indexed.map((row) => row.signature));
  const fileSigs = new Set(
    bundle.decisions.filter((row) => inScope(row.timestamp, bundle)).map((row) => row.signature),
  );
  for (const signature of [...population].sort()) {
    if (!fileSigs.has(signature)) {
      failures.push(`signature ${signature} is in the indexed date_range and missing from the file`);
    }
  }
  for (const signature of [...fileSigs].sort()) {
    if (!population.has(signature)) {
      failures.push(`signature ${signature} is in the file and not in the indexed date_range`);
    }
  }
  return failures;
}

export async function assessRecord(
  record: DecisionRecord,
  rpc: string,
  conn: Connection,
  opts?: AssessOpts,
): Promise<Verdict> {
  const cache = makeCache(conn, rpc, opts);
  const { failures, notes } = await checkRecord(record, rpc, cache);
  if (failures.length > 0) {
    return { ok: false, failures, text: rejectedText(failures, notes) };
  }
  const genesis = cache.genesis ?? record.genesis_hash;
  const lines = [...notes.map((note) => `note: ${note}`), ...confirmedLines(record, rpc, genesis, cache.programSource)];
  return { ok: true, failures: [], text: `${lines.join("\n")}\n` };
}

export async function assessBundle(
  bundle: DecisionBundle,
  rpc: string,
  conn: Connection,
  opts?: AssessOpts,
): Promise<Verdict> {
  if (bundle.completeness !== COMPLETENESS) {
    const failures = [
      `completeness must be "${COMPLETENESS}" (complete over payments, never over attempts); file has ${JSON.stringify(bundle.completeness)}`,
    ];
    return { ok: false, failures, text: rejectedText(failures) };
  }
  const cache = makeCache(conn, rpc, opts);
  const envelope = await bundleFailures(bundle, cache);
  const rows: RowVerdict[] = [];
  for (const [i, record] of bundle.decisions.entries()) {
    let failures: string[];
    try {
      failures = (await checkRecord(record, rpc, cache)).failures;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures = [message];
    }
    rows.push({
      index: i + 1,
      signature: record.signature,
      kind: record.kind,
      nonce: record.nonce.toString(),
      ok: failures.length === 0,
      failures,
    });
  }
  const report = formatBulkReport(rows);
  const context = populationLines(bundle, cache);
  if (envelope.length === 0) {
    return {
      ok: report.ok,
      failures: rows.flatMap((row) => row.failures),
      text: insertContext(report.text, context),
    };
  }
  const lines = ["VERDICT: REJECTED", "", ...context, ""];
  for (const failure of envelope) lines.push(`- ${failure}`);
  if (!report.ok) {
    for (const row of rows) {
      if (row.ok) continue;
      lines.push("");
      lines.push(`REJECTED row ${row.index} signature=${row.signature} kind=${row.kind} nonce=${row.nonce}`);
      for (const failure of row.failures) lines.push(`- ${failure}`);
    }
  }
  lines.push("");
  return {
    ok: false,
    failures: [...envelope, ...rows.flatMap((row) => row.failures)],
    text: `${lines.join("\n")}\n`,
  };
}

function populationLines(bundle: DecisionBundle, cache: CheckCache): string[] {
  const scope = bundle.scope;
  const lines = [
    `scope               ${scope.type}`,
    `mandate             ${scope.mandate ?? "none"}`,
    `from                ${scope.from === null ? "none" : String(scope.from)}`,
    `to                  ${scope.to === null ? "none" : String(scope.to)}`,
    `program_id          ${cache.expectedProgramId.toBase58()}`,
    `cluster             ${cache.genesis ? clusterForGenesis(cache.genesis) : bundle.cluster}`,
    `checked against program ${cache.expectedProgramId.toBase58()} (${cache.programSource})`,
  ];
  if (scope.mandate) {
    const mandate = cache.mandates.get(scope.mandate);
    if (mandate) {
      const paid = bundle.decisions.filter((row) => row.kind === "paid").length;
      const refused = bundle.decisions.filter((row) => row.kind === "refused").length;
      lines.push(
        `ledger              spend_count=${mandate.spendCount} refusal_count=${mandate.refusalCount}, file: paid=${paid} refused=${refused}`,
      );
    }
  }
  return lines;
}

function insertContext(text: string, context: string[]): string {
  const lines = text.split("\n");
  lines.splice(2, 0, ...context, "");
  return lines.join("\n");
}

function makeCache(conn: Connection, rpc: string, opts?: AssessOpts): CheckCache {
  const program = programChoice(opts);
  return {
    conn,
    expectedProgramId: program.programId,
    programSource: program.source,
    rpc,
    allowBlockScan: opts?.allowBlockScan === true,
    pageSize: opts?.pageSize,
    mandates: new Map(),
    ledgers: new Map(),
    destOwners: new Map(),
    txs: new Map(),
  };
}

async function cachedTransaction(
  cache: CheckCache,
  signature: string,
): Promise<Awaited<ReturnType<Connection["getTransaction"]>>> {
  if (cache.txs.has(signature)) return cache.txs.get(signature) ?? null;
  const tx = await cache.conn.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  cache.txs.set(signature, tx);
  return tx;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.flags.help || cli.flags.h) usage();
  const path = cli.positional[0];
  if (!path && process.stdin.isTTY) usage();
  const rpcs = resolveRpcList(cli);
  const rpc = rpcs.join(",");
  let parsed;
  try {
    parsed = parseExportText(readInput(path));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail([`record is not valid schema version 1 JSON or CSV: ${message}`]);
  }
  const conn = connection(rpcs);
  const flagged = flagString(cli, "program-id");
  const pageSizeStr = flagString(cli, "page-size");
  const pageSize = pageSizeStr !== undefined ? Number(pageSizeStr) : undefined;
  const opts: AssessOpts = {
    ...(flagged ? { programId: new PublicKey(flagged) } : {}),
    allowBlockScan: cli.flags["block-scan"] === true,
    ...(pageSize !== undefined ? { pageSize } : {}),
  };
  if (parsed.kind === "single") {
    const result = await assessRecord(parsed.record, rpc, conn, opts);
    process.stdout.write(result.text);
    if (!result.ok) process.exit(1);
    return;
  }
  const result = await assessBundle(parsed.bundle, rpc, conn, opts);
  process.stdout.write(result.text);
  if (!result.ok) process.exit(1);
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
    console.error(`verify failed: ${message}`);
    process.exit(1);
  });
}
