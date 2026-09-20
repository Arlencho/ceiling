import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import {
  connection,
  fetchLedger,
  fetchMandate,
  indexedEntries,
  kindByte,
  ledgerPda,
  parseArgs,
  parseChargeFromTx,
  parseChargeLogs,
  parseRecord,
  reasonText,
  resolveRpc,
  tokenAccountOwner,
  type DecisionRecord,
} from "./lib.js";

function usage(): never {
  console.error(`verify a Veto decision record against the chain

Usage:
  npx tsx verify.ts <file.json> [--rpc url]
  npx tsx export.ts --signature <tx> | npx tsx verify.ts

Exit 0 on CONFIRMED, 1 on REJECTED, 2 on usage error.
Does not need a keypair. Re-reads the cluster independently of the phone.
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

async function verify(record: DecisionRecord, rpc: string): Promise<void> {
  const failures: string[] = [];
  const conn = connection(rpc);
  const programId = new PublicKey(record.program_id);
  const mandatePk = new PublicKey(record.mandate);

  const genesis = await conn.getGenesisHash();
  eq(record.genesis_hash, genesis, "genesis_hash", failures);

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

  const tx = await conn.getTransaction(record.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    failures.push(
      `signature ${record.signature} not found on ${rpc} (wrong cluster, tampered signature, or history pruned)`,
    );
    fail(failures);
  }
  if (tx.meta?.err) {
    failures.push(`transaction failed on chain: ${JSON.stringify(tx.meta.err)}`);
  }

  const charge = parseChargeFromTx(tx, programId);
  if (!charge) {
    failures.push(`transaction does not invoke charge on ${programId.toBase58()}`);
    fail(failures);
  }
  eq(record.amount, charge.amount, "amount (instruction)", failures);
  eq(record.nonce, charge.nonce, "nonce (instruction)", failures);
  eq(record.mandate, charge.mandate.toBase58(), "mandate (instruction)", failures);
  eq(record.counterparty, charge.destination.toBase58(), "counterparty (destination)", failures);

  const expectedLedger = ledgerPda(programId, mandatePk);
  eq(charge.ledger.toBase58(), expectedLedger.toBase58(), "ledger PDA", failures);

  const mandate = await fetchMandate(conn, mandatePk);
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

  const destOwner = await tokenAccountOwner(conn, charge.destination);
  if (!destOwner.equals(mandate.merchant)) {
    failures.push(
      `destination token account owner is ${destOwner.toBase58()}, mandate merchant is ${mandate.merchant.toBase58()}`,
    );
  }

  const ledger = await fetchLedger(conn, expectedLedger);
  if (!ledger.mandate.equals(mandatePk)) {
    failures.push(`ledger.mandate is ${ledger.mandate.toBase58()}, expected ${record.mandate}`);
  }
  const wantKind = kindByte(record.kind);
  const rows = indexedEntries(ledger).filter(
    (row) => row.entry.nonce === record.nonce && row.entry.kind === wantKind,
  );
  const logs = parseChargeLogs(tx.meta?.logMessages ?? []);
  if (rows.length === 0) {
    if (!logs) {
      failures.push("ledger ring has no matching row and transaction logs have neither PAID nor REFUSED");
    } else {
      console.log("note: ledger ring no longer holds this decision; checking transaction logs");
      eq(record.kind, logs.kind, "kind (logs)", failures);
      eq(record.reason_code, logs.reasonCode, "reason_code (logs)", failures);
      eq(record.amount, logs.amount, "amount (logs)", failures);
      eq(record.suggested_override, logs.suggestedOverride, "suggested_override (logs)", failures);
      if (record.reason_text !== logs.reasonText) {
        failures.push(`reason_text: record has "${record.reason_text}", logs have "${logs.reasonText}"`);
      }
    }
  } else {
    const entry = rows[rows.length - 1]!.entry;
    eq(record.amount, entry.amount, "amount (ledger)", failures);
    eq(record.nonce, entry.nonce, "nonce (ledger)", failures);
    eq(record.timestamp, entry.ts, "timestamp (ledger)", failures);
    eq(record.counterparty, entry.counterparty.toBase58(), "counterparty (ledger)", failures);
    eq(record.suggested_override, entry.suggestedOverride, "suggested_override (ledger)", failures);
    eq(record.reason_code, entry.reason, "reason_code (ledger)", failures);
    const chainKind = entry.kind === 1 ? "paid" : entry.kind === 2 ? "refused" : String(entry.kind);
    eq(record.kind, chainKind, "kind (ledger)", failures);
  }

  if (logs) {
    eq(record.kind, logs.kind, "kind (logs)", failures);
    eq(record.reason_code, logs.reasonCode, "reason_code (logs)", failures);
  }

  if (failures.length > 0) fail(failures);

  console.log("VERDICT: CONFIRMED");
  console.log("");
  console.log(`rpc                 ${rpc}`);
  console.log(`cluster             ${record.cluster}`);
  console.log(`genesis_hash        ${record.genesis_hash}`);
  console.log(`program_id          ${record.program_id}`);
  console.log(`mandate             ${record.mandate}`);
  console.log(`signature           ${record.signature}`);
  console.log(`kind                ${record.kind}`);
  console.log(`amount              ${record.amount.toString()}`);
  console.log(`counterparty        ${record.counterparty}`);
  console.log(`timestamp           ${record.timestamp.toString()}`);
  console.log(`nonce               ${record.nonce.toString()}`);
  console.log(`reason              ${record.reason_code} (${record.reason_text})`);
  console.log(`suggested_override  ${record.suggested_override.toString()}`);
  console.log(
    `limits              cap=${record.limits.cap.toString()} per_tx_max=${record.limits.per_tx_max.toString()} expires_at=${record.limits.expires_at.toString()}`,
  );
  console.log(`merchant            ${record.limits.merchant}`);
  console.log(`purpose             ${record.limits.purpose}`);
  console.log("");
  console.log("Mandate limits, ledger entry, and charge transaction agree.");
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.flags.help || cli.flags.h) usage();
  const path = cli.positional[0];
  if (!path && process.stdin.isTTY) usage();
  const rpc = resolveRpc(cli);
  let parsed: DecisionRecord;
  try {
    parsed = parseRecord(JSON.parse(readInput(path)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail([`record is not valid schema version 1 JSON: ${message}`]);
  }
  await verify(parsed, rpc);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`verify failed: ${message}`);
  process.exit(1);
});
