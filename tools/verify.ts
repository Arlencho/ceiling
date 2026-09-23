import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchDecisionHistory } from "../indexer/src/index.js";
import { ListedTransactionMissingError, TransportError, asTransportError, isTransportError } from "../indexer/src/rpc.js";
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
  bindByTriple,
  boundVetoDecision,
  indexedEntries,
  kindByte,
  ledgerPda,
  mandateLifecycle,
  mandatePda,
  parseArgs,
  parseChargeFromTx,
  reasonText,
  redactRpcUrls,
  resolveRpcList,
  resolveVerifyProgramId,
  ringEntryForSignature,
  ringRowForLogKind,
  tokenAccountOwner,
  type ChargeIx,
  type DecisionRecord,
  type LedgerEntry,
  type MandateAccount,
  type OpenedMandate,
} from "./lib.js";

export type Verdict = {
  ok: boolean;
  failures: string[];
  text: string;
  code: 0 | 1 | 3;
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

Exit 0 on CONFIRMED, 1 on REJECTED, 2 on usage error, 3 when a row was not checked.
A rate limit, timeout, or network error while checking a row is not a verdict.
The run names that row as not checked and exits 3.
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

type ClosedHistory =
  | {
      ok: true;
      covered: Map<string, OpenedMandate>;
      openCount: number;
      latestOpenSlot: number | null;
      current: OpenedMandate | null;
    }
  | { ok: false; failure: string };

type LimitView = {
  owner: PublicKey;
  mandateId: bigint;
  merchant: PublicKey;
  cap: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  purpose: string;
  fromOpening: boolean;
  // The account is open again under a later tenure. The ledger that exists
  // now is that tenure's ring, not this signature's.
  ringSuperseded: boolean;
};

type MandateSignature = { signature: string; err: unknown; slot: number | null };

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
  closedHistory: Map<string, ClosedHistory>;
  mandateSignatures: Map<string, MandateSignature[]>;
  destOwners: Map<string, PublicKey>;
  txs: Map<string, Awaited<ReturnType<Connection["getTransaction"]>>>;
};

function txBlockTime(tx: { blockTime?: number | null }): number | null {
  return typeof tx.blockTime === "number" ? tx.blockTime : null;
}

// Clock unix time and the transaction's block time can differ by a couple of
// seconds for one charge. A ring row further away was written by another transaction.
const SAME_CHARGE_CLOCK_SKEW_S = 2n;

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

const CLOSED_NOTE = "mandate account is closed and the limits came from the opening transaction";

async function listMandateSignatures(cache: CheckCache, mandate: PublicKey): Promise<MandateSignature[]> {
  const key = mandate.toBase58();
  const cached = cache.mandateSignatures.get(key);
  if (cached) return cached;
  const out: MandateSignature[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  const limit = 1000;
  for (;;) {
    let batch: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>;
    try {
      batch = await cache.conn.getSignaturesForAddress(mandate, { limit, before });
    } catch (err) {
      throw asTransportError(err);
    }
    if (batch.length === 0) break;
    let added = 0;
    for (const item of batch) {
      if (seen.has(item.signature)) continue;
      seen.add(item.signature);
      added += 1;
      out.push({
        signature: item.signature,
        err: item.err,
        slot: typeof item.slot === "number" ? item.slot : null,
      });
    }
    if (batch.length < limit) break;
    const last = batch[batch.length - 1];
    // A full page that adds nothing, or that ends where this page started,
    // would repeat forever. One signature listed twice in a short page is one transaction.
    if (!last || added === 0 || last.signature === before) {
      throw new Error("mandate history cannot be read completely: a signature repeated");
    }
    before = last.signature;
  }
  cache.mandateSignatures.set(key, out);
  return out;
}

function txSlot(tx: { slot?: unknown } | null): number | null {
  if (!tx || typeof tx.slot !== "number") return null;
  return tx.slot;
}

// The live account's limits belong to the tenure that is open now. A later
// signature may be the open that started that tenure, so a record in an
// earlier slot has to be read from history. No later slot means this
// signature is not below the latest open.
async function mustReadMandateTenure(cache: CheckCache, mandatePk: PublicKey, signature: string): Promise<boolean> {
  if (typeof cache.conn.getSignaturesForAddress !== "function") return false;
  const pages = await listMandateSignatures(cache, mandatePk);
  const recordSlot = txSlot(await cachedTransaction(cache, signature));
  if (recordSlot === null) return true;
  return pages.some((page) => !page.err && (page.slot === null || page.slot > recordSlot));
}

function remember(cache: CheckCache, mandate: string, history: ClosedHistory): ClosedHistory {
  cache.closedHistory.set(mandate, history);
  return history;
}

// The same PDA can be closed and opened again. A signature is covered by the
// open_mandate that is still open when that signature is reached, and by no
// later one. A second open before a close, or a close before an open, is
// ambiguous. A null body is not a missing tenure.
async function closedMandateHistory(cache: CheckCache, mandatePk: PublicKey): Promise<ClosedHistory> {
  const key = mandatePk.toBase58();
  const cached = cache.closedHistory.get(key);
  if (cached) return cached;
  const pages = await listMandateSignatures(cache, mandatePk);
  const covered = new Map<string, OpenedMandate>();
  let current: OpenedMandate | null = null;
  let openCount = 0;
  let latestOpenSlot: number | null = null;
  for (const page of [...pages].reverse()) {
    if (page.err) continue;
    const tx = await cachedTransaction(cache, page.signature);
    if (!tx) {
      throw new TransportError(`the RPC returned no transaction for a listed signature ${page.signature}`);
    }
    let mark: ReturnType<typeof mandateLifecycle>;
    try {
      mark = mandateLifecycle(tx, cache.expectedProgramId, mandatePk);
    } catch (err) {
      if (isTransportError(err)) throw err;
      const message = failureText(err);
      return remember(cache, key, { ok: false, failure: `mandate history cannot be read completely: ${message}` });
    }
    if (mark.opens.length > 0 && mark.closes > 0) {
      return remember(cache, key, {
        ok: false,
        failure: "mandate history is ambiguous: one transaction both opens and closes the mandate",
      });
    }
    if (mark.opens.length > 1) {
      return remember(cache, key, {
        ok: false,
        failure: "mandate history is ambiguous: one transaction opens the mandate more than once",
      });
    }
    if (mark.closes > 1) {
      return remember(cache, key, {
        ok: false,
        failure: "mandate history is ambiguous: one transaction closes the mandate more than once",
      });
    }
    if (current) covered.set(page.signature, current);
    if (mark.opens.length === 1) {
      if (current) {
        return remember(cache, key, {
          ok: false,
          failure: "mandate history is ambiguous: a mandate was opened again before it was closed",
        });
      }
      openCount += 1;
      if (page.slot !== null && (latestOpenSlot === null || page.slot > latestOpenSlot)) {
        latestOpenSlot = page.slot;
      }
      current = mark.opens[0]!;
    } else if (mark.closes === 1) {
      if (!current) {
        return remember(cache, key, {
          ok: false,
          failure: "mandate history is ambiguous: a mandate was closed before it was opened",
        });
      }
      current = null;
    }
  }
  return remember(cache, key, { ok: true, covered, openCount, latestOpenSlot, current });
}

function liveLimits(mandate: MandateAccount): LimitView {
  return {
    owner: mandate.owner,
    mandateId: mandate.mandateId,
    merchant: mandate.merchant,
    cap: mandate.cap,
    perTxMax: mandate.perTxMax,
    expiresAt: mandate.expiresAt,
    purpose: mandate.purpose,
    fromOpening: false,
    ringSuperseded: false,
  };
}

function sameOpen(a: OpenedMandate, b: OpenedMandate): boolean {
  return (
    a.owner.equals(b.owner) &&
    a.mandateId === b.mandateId &&
    a.merchant.equals(b.merchant) &&
    a.cap === b.cap &&
    a.perTxMax === b.perTxMax &&
    a.expiresAt === b.expiresAt &&
    a.purpose === b.purpose
  );
}

function openingLimits(opened: OpenedMandate, ringSuperseded: boolean): LimitView {
  return {
    owner: opened.owner,
    mandateId: opened.mandateId,
    merchant: opened.merchant,
    cap: opened.cap,
    perTxMax: opened.perTxMax,
    expiresAt: opened.expiresAt,
    purpose: opened.purpose,
    fromOpening: true,
    ringSuperseded,
  };
}

async function limitSource(
  record: DecisionRecord,
  cache: CheckCache,
  failures: string[],
  notes: string[],
): Promise<LimitView | undefined> {
  const mandatePk = new PublicKey(record.mandate);
  let live = cache.mandates.get(record.mandate);
  if (!live) {
    try {
      live = await fetchMandate(cache.conn, mandatePk);
      cache.mandates.set(record.mandate, live);
    } catch (err) {
      if (isTransportError(err)) throw err;
      const message = failureText(err);
      if (!message.startsWith("mandate account not found")) {
        failures.push(message);
        return undefined;
      }
    }
  }
  // A live account is the tenure that is open now. An earlier signature takes
  // its limits from the open that covered it, the same walk a closed account uses.
  let history: ClosedHistory;
  try {
    if (live && !(await mustReadMandateTenure(cache, mandatePk, record.signature))) {
      return liveLimits(live);
    }
    history = await closedMandateHistory(cache, mandatePk);
  } catch (err) {
    if (isTransportError(err)) throw err;
    failures.push(failureText(err));
    return undefined;
  }
  if (!history.ok) {
    failures.push(history.failure);
    return undefined;
  }
  const recordSlot = txSlot(await cachedTransaction(cache, record.signature));
  const belowLatest =
    history.latestOpenSlot !== null && (recordSlot === null || recordSlot < history.latestOpenSlot);
  // One open, and this signature is not below it: the live account is that tenure.
  if (live && history.openCount < 2 && !belowLatest) return liveLimits(live);
  const opened = history.covered.get(record.signature);
  if (!opened) {
    failures.push(`mandate history does not cover signature ${record.signature}`);
    return undefined;
  }
  // The open that is still current is the live tenure, so its ring is evidence.
  // An earlier open is not. A closed account has no current open.
  if (live && history.current && sameOpen(opened, history.current)) return liveLimits(live);
  notes.push(CLOSED_NOTE);
  return openingLimits(opened, Boolean(live));
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

  let genesis = cache.genesis;
  if (!genesis) {
    try {
      genesis = await conn.getGenesisHash();
    } catch (err) {
      rethrowUnlessInvalidParam(err);
    }
    cache.genesis = genesis;
  }
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

  const charges = parseChargeFromTx(tx, programId);
  if (charges.length === 0) {
    failures.push(`transaction does not invoke charge on ${programId.toBase58()}`);
    return { failures, notes };
  }
  const chargeWant = {
    mandate: record.mandate,
    nonce: record.nonce,
    amount: record.amount,
  };
  const matchedCharges = bindByTriple(charges, chargeWant, (item) => ({
    mandate: item.mandate.toBase58(),
    nonce: item.nonce,
    amount: item.amount,
  }));
  // One charge that does not match still reports the field difference.
  // Several charges and zero or several hits do not pick a side.
  if (matchedCharges.length !== 1 && charges.length !== 1) {
    failures.push(
      `transaction carries ${matchedCharges.length} charges matching mandate, nonce, and amount`,
    );
    return { failures, notes };
  }
  const charge = matchedCharges[0] ?? charges[0]!;
  eq(record.amount, charge.amount, "amount (instruction)", failures);
  eq(record.nonce, charge.nonce, "nonce (instruction)", failures);
  eq(record.mandate, charge.mandate.toBase58(), "mandate (instruction)", failures);
  eq(record.counterparty, charge.destination.toBase58(), "counterparty (destination)", failures);

  const expectedLedger = ledgerPda(programId, mandatePk);
  eq(charge.ledger.toBase58(), expectedLedger.toBase58(), "ledger PDA", failures);

  const limits = await limitSource(record, cache, failures, notes);
  if (!limits) return { failures, notes };
  eq(record.limits.cap, limits.cap, "limits.cap", failures);
  eq(record.limits.per_tx_max, limits.perTxMax, "limits.per_tx_max", failures);
  eq(record.limits.expires_at, limits.expiresAt, "limits.expires_at", failures);
  eq(record.limits.merchant, limits.merchant.toBase58(), "limits.merchant", failures);
  if (record.limits.purpose !== limits.purpose) {
    failures.push(`limits.purpose: record has "${record.limits.purpose}", chain has "${limits.purpose}"`);
  }
  const derived = mandatePda(programId, limits.owner, limits.mandateId);
  if (!derived.equals(mandatePk)) {
    failures.push(
      `mandate PDA re-derived from on-chain owner+mandate_id is ${derived.toBase58()}, record has ${record.mandate}`,
    );
  }

  let destOwner = cache.destOwners.get(charge.destination.toBase58());
  if (!destOwner) {
    const loaded = await accountOrFailure(failures, () => tokenAccountOwner(conn, charge.destination));
    if (loaded) {
      destOwner = loaded;
      cache.destOwners.set(charge.destination.toBase58(), destOwner);
    }
  }
  if (destOwner && !destOwner.equals(limits.merchant)) {
    failures.push(
      `destination token account owner is ${destOwner.toBase58()}, mandate merchant is ${limits.merchant.toBase58()}`,
    );
  }

  const ledgerKey = expectedLedger.toBase58();
  let ledger = cache.ledgers.get(ledgerKey);
  if (!ledger) {
    try {
      const loaded = await fetchLedger(conn, expectedLedger);
      ledger = loaded;
      cache.ledgers.set(ledgerKey, ledger);
    } catch (err) {
      if (isTransportError(err)) throw err;
      const message = failureText(err);
      // close_mandate reclaims the ledger with the mandate. The ring is gone;
      // the charge transaction is the evidence.
      if (!(limits.fromOpening && message.startsWith("ledger account not found"))) {
        failures.push(message);
        return { failures, notes };
      }
    }
  }
  // Chain data, not the file. Two charges can share a nonce and differ by amount.
  const want = {
    mandate: charge.mandate.toBase58(),
    nonce: charge.nonce,
    amount: charge.amount,
  };
  const held = ledger;
  if (held && !held.mandate.equals(mandatePk)) {
    failures.push(`ledger.mandate is ${held.mandate.toBase58()}, expected ${record.mandate}`);
  }
  // A reopened account's ring belongs to the live tenure. Rows in it can repeat
  // an earlier tenure's nonce and amount, so they do not confirm that tenure.
  const rows =
    held && !limits.ringSuperseded
      ? bindByTriple(indexedEntries(held), want, (row) => ({
          mandate: held.mandate.toBase58(),
          nonce: row.entry.nonce,
          amount: row.entry.amount,
        }))
      : [];
  const bound = boundVetoDecision(tx.meta?.logMessages ?? [], programId, want);
  const blockTime = txBlockTime(tx);
  if (rows.length === 0) {
    if (bound.status === "none") {
      failures.push("ledger ring has no matching row and transaction logs have neither PAID nor REFUSED");
    } else if (bound.status === "error") {
      failures.push(bound.error);
    } else {
      const logs = bound.decision;
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
    const timePick = ringEntryForSignature(rows, blockTime, record.signature);
    const logKind = bound.status === "one" ? kindByte(bound.decision.kind) : null;
    const picked = ringRowForLogKind(timePick, rows, blockTime, record.signature, logKind);
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
      // The bound row has to be this transaction's. A twin from another tenure
      // can share the nonce and the amount and still land at a different time.
      if (blockTime !== null) {
        const landed = BigInt(blockTime);
        const delta = entry.ts >= landed ? entry.ts - landed : landed - entry.ts;
        if (delta > SAME_CHARGE_CLOCK_SKEW_S) {
          failures.push(
            `timestamp (transaction): ledger row is at ${entry.ts.toString()}, transaction landed at ${blockTime}`,
          );
        }
      }
    }
  }

  // Same triple as the ring. The first Veto line in the transaction is not the decision.
  if (rows.length > 0 && bound.status === "error") {
    failures.push(bound.error);
  } else if (rows.length > 0 && bound.status === "one") {
    eq(record.kind, bound.decision.kind, "kind (logs)", failures);
    eq(record.reason_code, bound.decision.reasonCode, "reason_code (logs)", failures);
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

type FailureSplit = {
  failures: string[];
  // Signatures the node listed and then did not return a transaction for.
  // assessBundle branches on this list. Envelope lines also embed free-text
  // fields from the file, so a scan of those lines is not a transport signal.
  unread: string[];
};

function inScope(ts: bigint, bundle: DecisionBundle): boolean {
  if (bundle.scope.type !== "date_range") return true;
  if (bundle.scope.from !== null && ts < BigInt(bundle.scope.from)) return false;
  if (bundle.scope.to !== null && ts > BigInt(bundle.scope.to)) return false;
  return true;
}

async function bundleFailures(bundle: DecisionBundle, cache: CheckCache): Promise<FailureSplit> {
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
    return { failures, unread: [] };
  }
  const population = await dateRangePopulationFailures(bundle, cache);
  failures.push(...population.failures);
  return { failures, unread: population.unread };
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
  failures.push(...ledgerRowFailures(bundle, ledger));
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

function ledgerRowFailures(bundle: DecisionBundle, ledger: Awaited<ReturnType<typeof fetchLedger>>): string[] {
  const failures: string[] = [];
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
  return failures;
}

function undecodableChargeFailures(
  bundle: DecisionBundle,
  cache: CheckCache,
  transactions: Map<string, Awaited<ReturnType<Connection["getTransaction"]>>>,
  population: Set<string>,
): FailureSplit {
  const failures: string[] = [];
  const unread: string[] = [];
  const program = cache.expectedProgramId;
  for (const signature of [...transactions.keys()].sort()) {
    if (population.has(signature)) continue;
    const tx = transactions.get(signature);
    // A listed signature with no transaction was not read. Skipping it lets a
    // file that omits the payment confirm. That is not a verdict.
    if (!tx) {
      unread.push(signature);
      continue;
    }
    let charges: ChargeIx[] = [];
    try {
      charges = parseChargeFromTx(tx, program);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.startsWith("charge instruction") && !message.startsWith("charge account index")) throw err;
      failures.push(
        `signature ${signature} invokes charge on ${program.toBase58()} but carries no attributable Veto decision`,
      );
      continue;
    }
    if (charges.length === 0) continue;
    if (bundle.scope.mandate && charges.every((charge) => charge.mandate.toBase58() !== bundle.scope.mandate)) continue;
    failures.push(
      `signature ${signature} invokes charge on ${program.toBase58()} but carries no attributable Veto decision`,
    );
  }
  return { failures, unread };
}

function accountText(key: unknown): string | null {
  if (typeof key === "string") return key;
  if (key instanceof PublicKey) return key.toBase58();
  if (key && typeof key === "object") {
    const rec = key as { toBase58?: unknown; pubkey?: unknown };
    if (typeof rec.toBase58 === "function") {
      try {
        return (rec.toBase58 as () => string)();
      } catch {
        return null;
      }
    }
    if (rec.pubkey !== undefined) return accountText(rec.pubkey);
  }
  return null;
}

// Account keys survive a log flood. A truncated transaction rejects a
// mandate-scoped date_range only when this mandate is one of those keys.
// With no mandate in scope, every truncated signature still rejects.
function transactionNamesAccount(tx: unknown, account: string): boolean {
  if (!tx || typeof tx !== "object") return true;
  const body = tx as {
    transaction?: { message?: { accountKeys?: unknown[]; staticAccountKeys?: unknown[] } };
    meta?: { loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } } | null;
  };
  const message = body.transaction?.message;
  const keys: unknown[] = [];
  if (message && Array.isArray(message.accountKeys) && message.accountKeys.length > 0) {
    keys.push(...message.accountKeys);
  } else if (message && Array.isArray(message.staticAccountKeys)) {
    keys.push(...message.staticAccountKeys);
  }
  const loaded = body.meta?.loadedAddresses;
  if (loaded?.writable) keys.push(...loaded.writable);
  if (loaded?.readonly) keys.push(...loaded.readonly);
  if (keys.length === 0) return true;
  return keys.some((key) => accountText(key) === account);
}

function truncatedForScope(
  bundle: DecisionBundle,
  history: { truncated: readonly string[]; transactions: { get(signature: string): unknown } },
): string[] {
  if (!bundle.scope.mandate) return [...history.truncated];
  const mandate = bundle.scope.mandate;
  return history.truncated.filter((signature) => transactionNamesAccount(history.transactions.get(signature), mandate));
}

async function dateRangePopulationFailures(bundle: DecisionBundle, cache: CheckCache): Promise<FailureSplit> {
  const failures: string[] = [];
  const unread: string[] = [];
  let mandatePk: PublicKey | null = null;
  if (bundle.scope.mandate) {
    mandatePk = mandatePubkey(bundle.scope.mandate, failures);
    if (!mandatePk) return { failures, unread };
    try {
      await cachedMandate(cache, bundle.scope.mandate, mandatePk);
    } catch (err) {
      const missing = missingAccountMessage(err);
      if (!missing) throw err;
      failures.push(missing);
      return { failures, unread };
    }
  }
  let history: Awaited<ReturnType<typeof fetchDecisionHistory>>;
  try {
    history = await fetchDecisionHistory({
      rpcUrl: cache.rpc,
      programId: cache.expectedProgramId.toBase58(),
      mandate: bundle.scope.mandate ?? undefined,
      connection: cache.conn,
      allowBlockScan: cache.allowBlockScan,
      pageSize: cache.pageSize,
      from: bundle.scope.from,
      to: bundle.scope.to,
    });
  } catch (err) {
    if (err instanceof ListedTransactionMissingError) {
      return { failures, unread: [...err.signatures] };
    }
    throw err;
  }
  for (const [signature, fetched] of history.transactions) {
    cache.txs.set(signature, fetched);
  }
  const indexed = filterIndexed(history.decisions, {
    mandate: bundle.scope.mandate ?? undefined,
    from: bundle.scope.from,
    to: bundle.scope.to,
  });
  const population = new Set(indexed.map((row) => row.signature));
  const fromLabel = bundle.scope.from === null ? "none" : String(bundle.scope.from);
  const toLabel = bundle.scope.to === null ? "none" : String(bundle.scope.to);
  for (const row of bundle.decisions) {
    if (inScope(row.timestamp, bundle)) continue;
    failures.push(
      `signature ${row.signature} has timestamp ${row.timestamp.toString()} outside scope ${fromLabel}..${toLabel}`,
    );
  }
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
  // The ring cannot be truncated by a log flood. A date_range that names a
  // mandate still has to include every ring row whose timestamp is inside the window.
  if (mandatePk) {
    try {
      const ledger = await cachedLedger(cache, mandatePk);
      failures.push(...ledgerRowFailures(bundle, ledger));
    } catch (err) {
      const missing = missingAccountMessage(err);
      if (!missing) throw err;
      failures.push(missing);
    }
  }
  // A top-level charge with no attributable Veto decision is missing from the
  // indexed set. Fail closed. A scope that names no mandate has no single ring
  // to catch the same hole. A runtime "Log truncated" line is that hole named.
  for (const signature of truncatedForScope(bundle, history)) {
    failures.push(
      `signature ${signature} log ends with "Log truncated" and is not a complete decision list`,
    );
  }
  const charges = undecodableChargeFailures(bundle, cache, history.transactions, population);
  failures.push(...charges.failures);
  unread.push(...charges.unread);
  return { failures, unread };
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
    return { ok: false, failures, text: rejectedText(failures, notes), code: 1 };
  }
  const genesis = cache.genesis ?? record.genesis_hash;
  const lines = [...notes.map((note) => `note: ${note}`), ...confirmedLines(record, rpc, genesis, cache.programSource)];
  return { ok: true, failures: [], text: `${lines.join("\n")}\n`, code: 0 };
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
    return { ok: false, failures, text: rejectedText(failures), code: 1 };
  }
  const cache = makeCache(conn, rpc, opts);
  const envelopeReport = await bundleFailures(bundle, cache);
  if (envelopeReport.unread.length > 0) {
    const unread = envelopeReport.unread.map(
      (signature) =>
        `signature ${signature} was not checked: the RPC returned no transaction for a listed signature`,
    );
    const line = `verify failed: ${unread.join("; ")}`;
    return { ok: false, failures: unread, text: `${line}\n`, code: 3 };
  }
  const envelope = envelopeReport.failures;
  const rows: RowVerdict[] = [];
  for (const [i, record] of bundle.decisions.entries()) {
    let failures: string[];
    try {
      failures = (await checkRecord(record, rpc, cache)).failures;
    } catch (err) {
      if (isTransportError(err)) {
        const detail = err instanceof Error ? err.message : String(err);
        const line = `verify failed: row ${i + 1} signature=${record.signature} was not checked: ${detail}`;
        return { ok: false, failures: [line], text: `${line}\n`, code: 3 };
      }
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
      code: report.ok ? 0 : 1,
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
    code: 1,
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
    closedHistory: new Map(),
    mandateSignatures: new Map(),
    destOwners: new Map(),
    txs: new Map(),
  };
}

function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonRpcErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code = (err as { code: unknown }).code;
  return typeof code === "number" ? code : null;
}

// JSON-RPC -32602 is the node refusing a parameter from the file. A signature
// of the wrong size is a rejection of that file. Every other rejection of
// getTransaction and getGenesisHash is the transport, including a 200 that is
// not an envelope and a node that reports itself unhealthy (-32005).
function rethrowUnlessInvalidParam(err: unknown): never {
  if (jsonRpcErrorCode(err) === -32602) throw err;
  throw asTransportError(err);
}

// Account-load failures stay on the report. A transport failure still aborts
// the row: it is not a verdict, and it must not be rewritten as one.
async function accountOrFailure<T>(failures: string[], load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch (err) {
    if (isTransportError(err)) throw err;
    failures.push(failureText(err));
    return undefined;
  }
}

async function cachedTransaction(
  cache: CheckCache,
  signature: string,
): Promise<Awaited<ReturnType<Connection["getTransaction"]>>> {
  if (cache.txs.has(signature)) return cache.txs.get(signature) ?? null;
  let tx: Awaited<ReturnType<Connection["getTransaction"]>>;
  try {
    tx = await cache.conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    rethrowUnlessInvalidParam(err);
  }
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
    writeResult(await assessRecord(parsed.record, rpc, conn, opts));
    return;
  }
  writeResult(await assessBundle(parsed.bundle, rpc, conn, opts));
}

function writeResult(result: Verdict): void {
  if (result.code === 3) {
    process.stderr.write(result.text);
    process.exit(3);
  }
  process.stdout.write(result.text);
  if (result.code !== 0) process.exit(result.code);
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
    process.exit(isTransportError(err) ? 3 : 1);
  });
}
