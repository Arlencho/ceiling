import { PublicKey } from "@solana/web3.js";
import {
  buildRecord,
  kindByte,
  matchingRingEntry,
  parseRecord,
  recordToPlain,
  requireSignature,
  type DecisionRecord,
  type LedgerAccount,
  type LedgerEntry,
  type MandateAccount,
} from "./lib.js";

export const COMPLETENESS = "payments" as const;

export const COMPLETENESS_NOTE =
  "Complete over paid and refused charges that landed on chain. Never complete over attempts. A charge the agent never submitted cannot appear here, and this file does not invent rows for missing signatures.";

export type IndexedDecision = {
  signature: string;
  timestamp: number | null;
  mandate: string;
  amount: bigint;
  nonce: bigint;
  counterparty: string;
  kind: "paid" | "refused";
  reason: number;
  suggestedOverride: bigint;
};

export type ScopeFilter = {
  mandate?: string;
  from?: number | null;
  to?: number | null;
  kind?: "paid" | "refused";
  nonce?: bigint;
};

export type ExportScope = {
  type: "rule" | "date_range";
  mandate: string | null;
  from: number | null;
  to: number | null;
};

export type DecisionBundle = {
  schema_version: 1;
  completeness: typeof COMPLETENESS;
  completeness_note: string;
  cluster: string;
  genesis_hash: string;
  program_id: string;
  scope: ExportScope;
  decisions: DecisionRecord[];
};

export type ParsedExport =
  | { kind: "single"; record: DecisionRecord }
  | { kind: "bulk"; bundle: DecisionBundle };

export type RowVerdict = {
  index: number;
  signature: string;
  kind: string;
  nonce: string;
  ok: boolean;
  failures: string[];
};

export const CSV_COLUMNS = [
  "completeness",
  "scope_type",
  "scope_mandate",
  "scope_from",
  "scope_to",
  "schema_version",
  "cluster",
  "genesis_hash",
  "program_id",
  "mandate",
  "limits_cap",
  "limits_per_tx_max",
  "limits_expires_at",
  "limits_merchant",
  "limits_purpose",
  "kind",
  "amount",
  "counterparty",
  "timestamp",
  "nonce",
  "reason_code",
  "reason_text",
  "suggested_override",
  "signature",
] as const;

export function buildScope(filter: ScopeFilter): ExportScope {
  const mandate = filter.mandate ?? null;
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  if (from !== null || to !== null) {
    return { type: "date_range", mandate, from, to };
  }
  if (!mandate) {
    throw new Error("bulk export needs --mandate, or a date range via --from / --to");
  }
  return { type: "rule", mandate, from: null, to: null };
}

export function parseTimeBound(raw: string, endOfDay: boolean): number {
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new Error(`time bound is not a safe integer: ${raw}`);
    return n;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const date = Number(day[3]);
    if (endOfDay) {
      return Math.floor(Date.UTC(year, month - 1, date, 23, 59, 59) / 1000);
    }
    return Math.floor(Date.UTC(year, month - 1, date) / 1000);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`cannot parse time bound: ${raw}`);
  return Math.floor(ms / 1000);
}

export function filterIndexed<T extends IndexedDecision>(rows: readonly T[], filter: ScopeFilter): T[] {
  const out: T[] = [];
  for (const row of rows) {
    if (filter.mandate && row.mandate !== filter.mandate) continue;
    if (filter.kind && row.kind !== filter.kind) continue;
    if (filter.nonce !== undefined && row.nonce !== filter.nonce) continue;
    if (!inTimeRange(row.timestamp, filter.from ?? null, filter.to ?? null)) continue;
    out.push(row);
  }
  return out;
}

function inTimeRange(ts: number | null, from: number | null, to: number | null): boolean {
  if (from === null && to === null) return true;
  if (ts === null) return false;
  if (from !== null && ts < from) return false;
  if (to !== null && ts > to) return false;
  return true;
}

export function buildRecordFromIndexed(args: {
  cluster: string;
  genesisHash: string;
  programId: PublicKey;
  mandateAccount: MandateAccount;
  decision: IndexedDecision;
  ringEntry?: LedgerEntry | null;
}): DecisionRecord {
  if (!args.decision.counterparty) {
    throw new Error(
      `indexer row ${args.decision.signature} has an empty counterparty (charge accounts were not decoded)`,
    );
  }
  const entry: LedgerEntry = args.ringEntry
    ? {
        ts: args.ringEntry.ts,
        amount: args.decision.amount,
        counterparty: args.ringEntry.counterparty,
        nonce: args.decision.nonce,
        suggestedOverride: args.decision.suggestedOverride,
        kind: kindByte(args.decision.kind),
        reason: args.decision.reason,
      }
    : {
        ts: args.decision.timestamp !== null ? BigInt(args.decision.timestamp) : 0n,
        amount: args.decision.amount,
        counterparty: new PublicKey(args.decision.counterparty),
        nonce: args.decision.nonce,
        suggestedOverride: args.decision.suggestedOverride,
        kind: kindByte(args.decision.kind),
        reason: args.decision.reason,
      };
  return buildRecord({
    cluster: args.cluster,
    genesisHash: args.genesisHash,
    programId: args.programId,
    mandate: new PublicKey(args.decision.mandate),
    mandateAccount: args.mandateAccount,
    entry,
    signature: args.decision.signature,
  });
}

export function overlayRing(ledger: LedgerAccount | null, decision: IndexedDecision): LedgerEntry | null {
  if (!ledger) return null;
  return matchingRingEntry(ledger, decision);
}

export function makeBundle(args: {
  cluster: string;
  genesisHash: string;
  programId: string;
  scope: ExportScope;
  decisions: DecisionRecord[];
}): DecisionBundle {
  return {
    schema_version: 1,
    completeness: COMPLETENESS,
    completeness_note: COMPLETENESS_NOTE,
    cluster: args.cluster,
    genesis_hash: args.genesisHash,
    program_id: args.programId,
    scope: args.scope,
    decisions: args.decisions,
  };
}

export function bundleToJson(bundle: DecisionBundle): string {
  const body = {
    schema_version: bundle.schema_version,
    completeness: bundle.completeness,
    completeness_note: bundle.completeness_note,
    cluster: bundle.cluster,
    genesis_hash: bundle.genesis_hash,
    program_id: bundle.program_id,
    scope: {
      type: bundle.scope.type,
      mandate: bundle.scope.mandate,
      from: bundle.scope.from,
      to: bundle.scope.to,
    },
    decisions: bundle.decisions.map(recordToPlain),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function parseBundle(input: unknown): DecisionBundle {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("bulk record must be a JSON object");
  }
  const o = input as Record<string, unknown>;
  const schema_version = Number(o.schema_version);
  if (schema_version !== 1) throw new Error(`unsupported schema_version: ${o.schema_version}`);
  if (o.completeness !== COMPLETENESS) {
    throw new Error(
      `completeness must be "${COMPLETENESS}" (complete over payments, never over attempts); file has ${JSON.stringify(o.completeness)}`,
    );
  }
  if (typeof o.completeness_note !== "string" || o.completeness_note.length === 0) {
    throw new Error("completeness_note must be a non-empty string");
  }
  if (typeof o.cluster !== "string" || o.cluster.length === 0) {
    throw new Error("cluster must be a non-empty string");
  }
  if (typeof o.genesis_hash !== "string" || o.genesis_hash.length === 0) {
    throw new Error("genesis_hash must be a non-empty string");
  }
  if (typeof o.program_id !== "string" || o.program_id.length === 0) {
    throw new Error("program_id must be a non-empty string");
  }
  if (!Array.isArray(o.decisions)) throw new Error("decisions must be an array");
  const decisions = o.decisions.map((row, i) => {
    try {
      return parseRecord(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`decisions[${i}]: ${message}`);
    }
  });
  for (const [i, row] of decisions.entries()) {
    if (!row.signature) throw new Error(`decisions[${i}] is missing signature`);
    if (row.signature.length >= 64) requireSignature(row.signature, `decisions[${i}].signature`);
  }
  return {
    schema_version: 1,
    completeness: COMPLETENESS,
    completeness_note: o.completeness_note,
    cluster: o.cluster,
    genesis_hash: o.genesis_hash,
    program_id: o.program_id,
    scope: parseScope(o.scope),
    decisions,
  };
}

function parseScope(input: unknown): ExportScope {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("scope must be an object");
  }
  const o = input as Record<string, unknown>;
  if (o.type !== "rule" && o.type !== "date_range") {
    throw new Error('scope.type must be "rule" or "date_range"');
  }
  const mandate =
    o.mandate === null || o.mandate === undefined || o.mandate === ""
      ? null
      : requireNonEmpty(o.mandate, "scope.mandate");
  const from = optionalInt(o.from, "scope.from");
  const to = optionalInt(o.to, "scope.to");
  if (o.type === "rule" && !mandate) throw new Error("scope.mandate is required when scope.type is rule");
  if (o.type === "date_range" && from === null && to === null) {
    throw new Error("date_range scope needs from and/or to");
  }
  return { type: o.type, mandate, from, to };
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function optionalInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${field} must be a safe integer`);
    }
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error(`${field} must be an integer or null`);
}

export function bundleToCsv(bundle: DecisionBundle): string {
  const lines: string[] = [
    `# completeness=${bundle.completeness}`,
    `# completeness_note=${bundle.completeness_note}`,
    `# cluster=${bundle.cluster}`,
    `# genesis_hash=${bundle.genesis_hash}`,
    `# program_id=${bundle.program_id}`,
    `# scope_type=${bundle.scope.type}`,
    `# scope_mandate=${bundle.scope.mandate ?? ""}`,
    `# scope_from=${bundle.scope.from ?? ""}`,
    `# scope_to=${bundle.scope.to ?? ""}`,
    CSV_COLUMNS.join(","),
  ];
  for (const rec of bundle.decisions) {
    lines.push(csvLine(rowValues(bundle, rec)));
  }
  return `${lines.join("\n")}\n`;
}

function rowValues(bundle: DecisionBundle, rec: DecisionRecord): string[] {
  return [
    bundle.completeness,
    bundle.scope.type,
    bundle.scope.mandate ?? "",
    bundle.scope.from === null ? "" : String(bundle.scope.from),
    bundle.scope.to === null ? "" : String(bundle.scope.to),
    String(rec.schema_version),
    rec.cluster,
    rec.genesis_hash,
    rec.program_id,
    rec.mandate,
    rec.limits.cap.toString(),
    rec.limits.per_tx_max.toString(),
    rec.limits.expires_at.toString(),
    rec.limits.merchant,
    rec.limits.purpose,
    rec.kind,
    rec.amount.toString(),
    rec.counterparty,
    rec.timestamp.toString(),
    rec.nonce.toString(),
    String(rec.reason_code),
    rec.reason_text,
    rec.suggested_override.toString(),
    rec.signature,
  ];
}

function csvLine(values: string[]): string {
  return values.map(csvEscape).join(",");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function parseCsv(text: string): DecisionBundle {
  const rawLines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const meta: Record<string, string> = {};
  const rows: string[] = [];
  for (const line of rawLines) {
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      const body = line.slice(1).trim();
      const eq = body.indexOf("=");
      if (eq > 0) meta[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    rows.push(line);
  }
  if (rows.length === 0) throw new Error("CSV has no header row");
  const header = parseCsvLine(rows[0]!);
  const index = new Map<string, number>();
  for (const [i, name] of header.entries()) index.set(name, i);
  for (const col of ["signature", "kind", "amount", "mandate"] as const) {
    if (!index.has(col)) throw new Error(`CSV is missing required column ${col}`);
  }
  const decisions: DecisionRecord[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cols = parseCsvLine(rows[r]!);
    if (cols.length === 1 && cols[0] === "") continue;
    const get = (name: string): string => {
      const i = index.get(name);
      if (i === undefined) return "";
      return cols[i] ?? "";
    };
    const completeness = get("completeness") || meta.completeness || "";
    if (completeness !== COMPLETENESS) {
      throw new Error(
        `CSV row ${r} completeness must be "${COMPLETENESS}"; file has ${JSON.stringify(completeness)}`,
      );
    }
    decisions.push(
      parseRecord({
        schema_version: Number(get("schema_version") || "1"),
        cluster: get("cluster") || meta.cluster,
        genesis_hash: get("genesis_hash"),
        program_id: get("program_id"),
        mandate: get("mandate"),
        limits: {
          cap: get("limits_cap"),
          per_tx_max: get("limits_per_tx_max"),
          expires_at: get("limits_expires_at"),
          merchant: get("limits_merchant"),
          purpose: get("limits_purpose"),
        },
        kind: get("kind"),
        amount: get("amount"),
        counterparty: get("counterparty"),
        timestamp: get("timestamp"),
        nonce: get("nonce"),
        reason_code: get("reason_code"),
        reason_text: get("reason_text"),
        suggested_override: get("suggested_override"),
        signature: get("signature"),
      }),
    );
  }
  const completeness = meta.completeness ?? firstColumnValue(index, rows, "completeness") ?? "";
  if (completeness !== COMPLETENESS) {
    throw new Error(
      `CSV completeness must be "${COMPLETENESS}" (complete over payments, never over attempts); file has ${JSON.stringify(completeness)}`,
    );
  }
  const scopeType = (meta.scope_type || firstColumnValue(index, rows, "scope_type") || "rule") as
    | "rule"
    | "date_range";
  if (scopeType !== "rule" && scopeType !== "date_range") {
    throw new Error('CSV scope_type must be "rule" or "date_range"');
  }
  const mandate =
    emptyToNull(meta.scope_mandate) ??
    emptyToNull(firstColumnValue(index, rows, "scope_mandate")) ??
    (decisions[0]?.mandate ?? null);
  const from = optionalInt(meta.scope_from || firstColumnValue(index, rows, "scope_from") || null, "scope_from");
  const to = optionalInt(meta.scope_to || firstColumnValue(index, rows, "scope_to") || null, "scope_to");
  const cluster = decisions[0]?.cluster ?? meta.cluster ?? "";
  const genesis = decisions[0]?.genesis_hash ?? meta.genesis_hash ?? "";
  const programId = decisions[0]?.program_id ?? meta.program_id ?? "";
  if (!cluster || !genesis || !programId) {
    if (decisions.length === 0) {
      if (!meta.cluster || !meta.genesis_hash || !meta.program_id) {
        throw new Error("empty CSV needs cluster, genesis_hash and program_id in the comment header");
      }
    }
  }
  const scope: ExportScope = {
    type: scopeType,
    mandate,
    from,
    to,
  };
  if (scope.type === "rule" && !scope.mandate) {
    throw new Error("CSV rule scope needs scope_mandate");
  }
  if (scope.type === "date_range" && scope.from === null && scope.to === null) {
    throw new Error("CSV date_range scope needs scope_from and/or scope_to");
  }
  return {
    schema_version: 1,
    completeness: COMPLETENESS,
    completeness_note: meta.completeness_note || COMPLETENESS_NOTE,
    cluster: cluster || meta.cluster,
    genesis_hash: genesis || meta.genesis_hash,
    program_id: programId || meta.program_id,
    scope,
    decisions,
  };
}

function firstColumnValue(index: Map<string, number>, rows: string[], name: string): string | undefined {
  const i = index.get(name);
  if (i === undefined) return undefined;
  for (let r = 1; r < rows.length; r += 1) {
    const cols = parseCsvLine(rows[r]!);
    const v = cols[i];
    if (v) return v;
  }
  return undefined;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return value;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function parseExportText(raw: string): ParsedExport {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("empty input");
  const looksCsv =
    trimmed.startsWith("#") ||
    trimmed.startsWith("completeness,") ||
    trimmed.startsWith("schema_version,") ||
    /^[a-z_]+,/.test(trimmed.split(/\r?\n/, 1)[0] ?? "");
  if (looksCsv && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { kind: "bulk", bundle: parseCsv(trimmed) };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    if (looksCsv) return { kind: "bulk", bundle: parseCsv(trimmed) };
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`not valid JSON: ${message}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("record must be a JSON object");
  }
  const o = json as Record<string, unknown>;
  if (Array.isArray(o.decisions)) {
    return { kind: "bulk", bundle: parseBundle(json) };
  }
  return { kind: "single", record: parseRecord(json) };
}

export function formatBulkReport(rows: readonly RowVerdict[]): {
  text: string;
  confirmed: number;
  rejected: number;
  ok: boolean;
} {
  const confirmed = rows.filter((r) => r.ok).length;
  const rejected = rows.filter((r) => !r.ok).length;
  const ok = rejected === 0;
  const lines: string[] = [
    `VERDICT: ${ok ? "CONFIRMED" : "REJECTED"}`,
    "",
    `confirmed: ${confirmed}`,
    `rejected: ${rejected}`,
  ];
  if (rows.length === 0) {
    lines.push("");
    lines.push("empty export: no paid or refused charges in this scope");
  }
  for (const row of rows) {
    if (row.ok) continue;
    lines.push("");
    lines.push(`REJECTED row ${row.index} signature=${row.signature} kind=${row.kind} nonce=${row.nonce}`);
    for (const failure of row.failures) {
      lines.push(`- ${failure}`);
    }
  }
  lines.push("");
  return { text: lines.join("\n"), confirmed, rejected, ok };
}

export function inferFormat(out: string | undefined, explicit: string | undefined): "json" | "csv" {
  if (explicit === "csv" || explicit === "json") return explicit;
  if (explicit !== undefined) throw new Error("--format must be json or csv");
  if (out && out.toLowerCase().endsWith(".csv")) return "csv";
  return "json";
}
