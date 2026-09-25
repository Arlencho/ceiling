import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeEventsFromLogs } from "../indexer/src/events.js";
import { asTransportError, isTransportError } from "../indexer/src/rpc.js";
import {
  clusterForGenesis,
  decodeTradeRule,
  decodeTradeLedger,
  parseTradeFromTx,
  requireSignature,
  tradeLedgerPda,
  tradeRulePda,
  tradeReasonText,
  type TradeRuleAccount,
  type TradeIx,
} from "./lib.js";

export type TradeLimits = {
  cap: bigint;
  per_trade_max: bigint;
  daily_limit: bigint;
  floor_num: bigint;
  floor_den: bigint;
  expires_at: bigint;
  pool: string;
  destination: string;
  in_mint: string;
  out_mint: string;
  purpose: string;
};
export type TradeDecisionRecord = {
  schema_version: 1;
  cluster: string;
  genesis_hash: string;
  program_id: string;
  rule: string;
  limits: TradeLimits;
  kind: "traded" | "refused";
  amount_in: bigint;
  amount_out: bigint;
  min_out: bigint;
  counterparty: string;
  timestamp: bigint;
  nonce: bigint;
  reason_code: number;
  reason_text: string;
  suggested_override: bigint;
  signature: string;
};

function integer(value: unknown, field: string, signed = false): bigint {
  if (
    typeof value !== "bigint" &&
    !(typeof value === "number" && Number.isSafeInteger(value)) &&
    !(typeof value === "string" && /^-?\d+$/.test(value))
  )
    throw new Error(`${field} must be an exact integer`);
  const n = BigInt(value);
  if (
    n < (signed ? -(1n << 63n) : 0n) ||
    n > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)
  )
    throw new Error(`${field} out of range`);
  return n;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}
function pubkey(value: unknown, field: string): string {
  const s = string(value, field);
  if (new PublicKey(s).toBase58() !== s)
    throw new Error(`${field} must be a canonical public key`);
  return s;
}
export function parseTradeRecord(input: unknown): TradeDecisionRecord {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("trade record must be an object");
  const o = input as Record<string, unknown>;
  if (
    o.schema_version !== 1 ||
    (o.kind !== "traded" && o.kind !== "refused") ||
    "mandate" in o ||
    "amount" in o
  )
    throw new Error("invalid version-1 trade record");
  if (!o.limits || typeof o.limits !== "object" || Array.isArray(o.limits))
    throw new Error("limits must be an object");
  const l = o.limits as Record<string, unknown>;
  const reason = Number(integer(o.reason_code, "reason_code"));
  if (reason > 14 || (o.kind === "traded" ? reason !== 0 : reason === 0))
    throw new Error("reason_code disagrees with trade kind");
  return {
    schema_version: 1,
    cluster: string(o.cluster, "cluster"),
    genesis_hash: string(o.genesis_hash, "genesis_hash"),
    program_id: pubkey(o.program_id, "program_id"),
    rule: pubkey(o.rule, "rule"),
    kind: o.kind,
    limits: {
      cap: integer(l.cap, "limits.cap"),
      per_trade_max: integer(l.per_trade_max, "limits.per_trade_max"),
      daily_limit: integer(l.daily_limit, "limits.daily_limit"),
      floor_num: integer(l.floor_num, "limits.floor_num"),
      floor_den: integer(l.floor_den, "limits.floor_den"),
      expires_at: integer(l.expires_at, "limits.expires_at", true),
      pool: pubkey(l.pool, "limits.pool"),
      destination: pubkey(l.destination, "limits.destination"),
      in_mint: pubkey(l.in_mint, "limits.in_mint"),
      out_mint: pubkey(l.out_mint, "limits.out_mint"),
      purpose: string(l.purpose, "limits.purpose"),
    },
    amount_in: integer(o.amount_in, "amount_in"),
    amount_out: integer(o.amount_out, "amount_out"),
    min_out: integer(o.min_out, "min_out"),
    counterparty: pubkey(o.counterparty, "counterparty"),
    timestamp: integer(o.timestamp, "timestamp", true),
    nonce: integer(o.nonce, "nonce"),
    reason_code: reason,
    reason_text: string(o.reason_text, "reason_text"),
    suggested_override: integer(o.suggested_override, "suggested_override"),
    signature: requireSignature(o.signature, "signature"),
  };
}
export function tradeRecordToJson(record: TradeDecisionRecord): string {
  return (
    JSON.stringify(
      record,
      (_key, value) => {
        if (typeof value !== "bigint") return value;
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : value.toString();
      },
      2,
    ) + "\n"
  );
}
function limits(rule: TradeRuleAccount): TradeLimits {
  return {
    cap: rule.cap,
    per_trade_max: rule.perTradeMax,
    daily_limit: rule.dailyLimit,
    floor_num: rule.floorNum,
    floor_den: rule.floorDen,
    expires_at: rule.expiresAt,
    pool: String(rule.pool),
    destination: String(rule.destination),
    in_mint: String(rule.inMint),
    out_mint: String(rule.outMint),
    purpose: rule.purpose,
  };
}
async function rpc<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw asTransportError(err);
  }
}
function counterparty(
  rule: TradeRuleAccount,
  ix: TradeIx,
  reason: number,
): string {
  if (reason === 11) return String(ix.accounts[4]);
  if (reason === 12) {
    const expected = [
      rule.pool,
      rule.poolAuthority,
      rule.poolInVault,
      rule.poolOutVault,
      rule.poolMint,
      rule.poolFeeAccount,
      rule.exchangeProgram,
    ];
    const indices = [6, 7, 8, 9, 10, 11, 5];
    for (let i = 0; i < indices.length; i++)
      if (!ix.accounts[indices[i]!]!.equals(expected[i]!))
        return String(ix.accounts[indices[i]!]);
    throw new Error("reason_code: pool refusal has no differing pool account");
  }
  return String(rule.pool);
}

// No historical reconstruction is claimed when the rule or its live ring is gone.
// Both are required for the three-way confirmation promised by this format.
export async function tradeRecordFromSignature(
  conn: Connection,
  signature: string,
  program: PublicKey,
  cluster: string,
  genesis: string,
  want?: { rule: string; nonce?: bigint; amountIn?: bigint },
): Promise<TradeDecisionRecord> {
  requireSignature(signature, "signature");
  const tx = await rpc(() =>
    conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
  );
  if (!tx || !tx.meta || tx.meta.err)
    throw new Error("trade transaction missing or failed");
  const trades = parseTradeFromTx(tx, program).filter(
    (ix) =>
      !want ||
      (String(ix.accounts[1]) === want.rule &&
        (want.nonce === undefined || ix.nonce === want.nonce) &&
        (want.amountIn === undefined || ix.amountIn === want.amountIn)),
  );
  if (trades.length !== 1)
    throw new Error(
      `trade transaction has ${trades.length} matching instructions; select rule, nonce, and amount_in`,
    );
  const ix = trades[0]!,
    address = ix.accounts[1]!;
  const ledgerAddress = tradeLedgerPda(program, address);
  if (!ix.accounts[2]!.equals(ledgerAddress))
    throw new Error("trade ledger PDA mismatch");
  const ruleInfo = await rpc(() => conn.getAccountInfo(address, "confirmed"));
  const ledgerInfo = await rpc(() =>
    conn.getAccountInfo(ledgerAddress, "confirmed"),
  );
  if (!ruleInfo || !ledgerInfo) throw new Error("trade rule or ledger missing");
  if (!ruleInfo.owner.equals(program) || !ledgerInfo.owner.equals(program))
    throw new Error("trade account owner mismatch");
  const rule = decodeTradeRule(Buffer.from(ruleInfo.data)),
    ledger = decodeTradeLedger(Buffer.from(ledgerInfo.data));
  if (
    !tradeRulePda(program, rule.owner, rule.ruleId).equals(address) ||
    !ledger.rule.equals(address)
  )
    throw new Error("trade rule PDA or ledger.rule mismatch");
  if (
    !ix.accounts[0]!.equals(rule.agent) ||
    !ix.accounts[3]!.equals(rule.source)
  )
    throw new Error("trade agent or source mismatch");
  const events = decodeEventsFromLogs(
    tx.meta.logMessages ?? [],
    String(program),
  ).filter(
    (e) =>
      e.rule === String(address) &&
      e.nonce === ix.nonce &&
      e.amountIn === ix.amountIn,
  );
  if (events.length !== 1)
    throw new Error(
      "trade transaction needs exactly one matching Traded or TradeRefused event",
    );
  const event = events[0]!;
  if (event.minOut !== undefined && event.minOut !== ix.minOut)
    throw new Error("min_out: event and trade instruction disagree");
  const party = counterparty(rule, ix, event.reason);
  const rows = ledger.entries.filter(
    (e) =>
      e.nonce === ix.nonce &&
      e.amountIn === ix.amountIn &&
      e.kind === event.kindCode &&
      e.reason === event.reason &&
      e.amountOut === event.amountOut &&
      e.minOut === ix.minOut &&
      String(e.counterparty) === party &&
      e.suggestedOverride === event.suggestedOverride,
  );
  const timed = rows.filter(
    (e) =>
      tx.blockTime != null &&
      e.ts >= BigInt(tx.blockTime) - 2n &&
      e.ts <= BigInt(tx.blockTime) + 2n,
  );
  if (timed.length !== 1)
    throw new Error(
      "trade ledger entry and transaction disagree or are ambiguous (amount_in, amount_out, min_out, nonce, timestamp, counterparty, kind, reason_code, suggested_override)",
    );
  const entry = timed[0]!;
  return {
    schema_version: 1,
    cluster,
    genesis_hash: genesis,
    program_id: String(program),
    rule: String(address),
    limits: limits(rule),
    kind: event.kind === "traded" ? "traded" : "refused",
    amount_in: entry.amountIn,
    amount_out: entry.amountOut,
    min_out: entry.minOut,
    counterparty: party,
    timestamp: entry.ts,
    nonce: entry.nonce,
    reason_code: entry.reason,
    reason_text: tradeReasonText(entry.reason),
    suggested_override: entry.suggestedOverride,
    signature,
  };
}

export async function assessTradeRecord(
  input: unknown,
  conn: Connection,
  program: PublicKey,
) {
  const failures: string[] = [];
  try {
    const record = parseTradeRecord(input);
    const genesis = await rpc(() => conn.getGenesisHash());
    if (record.program_id !== String(program))
      failures.push("program_id differs from trusted program");
    if (record.genesis_hash !== genesis)
      failures.push("genesis_hash differs from RPC");
    if (record.cluster !== clusterForGenesis(genesis))
      failures.push("cluster differs from RPC");
    const chain = await tradeRecordFromSignature(
      conn,
      record.signature,
      program,
      clusterForGenesis(genesis),
      genesis,
      { rule: record.rule, nonce: record.nonce, amountIn: record.amount_in },
    );
    for (const [field, value] of Object.entries(chain)) {
      if (field === "limits") {
        for (const [name, limit] of Object.entries(chain.limits))
          if (
            String(record.limits[name as keyof TradeLimits]) !== String(limit)
          )
            failures.push(`limits.${name}: record and chain differ`);
      } else if (
        String(record[field as keyof TradeDecisionRecord]) !== String(value)
      )
        failures.push(`${field}: record and chain differ`);
    }
  } catch (err) {
    if (isTransportError(err))
      return {
        ok: false,
        failures: [],
        text: "Trade record not checked: RPC unavailable.\n",
        code: 3 as const,
      };
    failures.push(err instanceof Error ? err.message : String(err));
  }
  if (failures.length)
    return {
      ok: false,
      failures,
      text: `VERDICT: REJECTED\n\n${failures.map((f) => `- ${f}`).join("\n")}\n`,
      code: 1 as const,
    };
  return {
    ok: true,
    failures,
    text: "VERDICT: CONFIRMED\n\nTrade rule limits, ledger entry, and trade transaction agree.\n",
    code: 0 as const,
  };
}
