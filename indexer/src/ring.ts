import { PublicKey } from "@solana/web3.js";
import { createFailoverConnection, parseRpcList, withRetry } from "./rpc.js";
import {
  buffersEqual,
  ENTRY_SIZE,
  kindName,
  LEDGER_ACCOUNT_SIZE,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  readI64Le,
  readU64Le,
  reasonText,
} from "./constants.js";
import type { LedgerSnapshot, RingEntry } from "./types.js";

export function ledgerPda(programId: PublicKey, mandate: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), mandate.toBuffer()],
    programId,
  );
  return pda;
}

export function mandatePda(programId: PublicKey, owner: PublicKey, mandateId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(mandateId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.toBuffer(), id],
    programId,
  );
  return pda;
}

export async function fetchLedgerRing(
  rpcUrl: string,
  programId: PublicKey,
  mandate: PublicKey,
): Promise<LedgerSnapshot> {
  const address = ledgerPda(programId, mandate);
  const endpoints = parseRpcList(rpcUrl);
  if (endpoints.length === 0) throw new Error("no rpc endpoints configured");
  const connection = createFailoverConnection(endpoints);
  const info = await withRetry(`getAccountInfo ${address.toBase58()}`, () =>
    connection.getAccountInfo(address, "confirmed"),
  );
  if (!info) {
    throw new Error(`ledger ${address.toBase58()} not found for mandate ${mandate.toBase58()}`);
  }
  return decodeLedgerAccount(address.toBase58(), info.data);
}

export function decodeLedgerAccount(address: string, data: Uint8Array): LedgerSnapshot {
  if (data.length < LEDGER_ACCOUNT_SIZE) {
    throw new Error(
      `ledger ${address} is ${data.length} bytes, expected ${LEDGER_ACCOUNT_SIZE}`,
    );
  }
  if (!buffersEqual(data.subarray(0, 8), LEDGER_DISCRIMINATOR)) {
    throw new Error(`ledger ${address} does not have the Ledger discriminator`);
  }
  const body = data.subarray(8);
  const mandate = new PublicKey(body.subarray(0, 32)).toBase58();
  const total = Buffer.from(body.subarray(32, 36)).readUInt32LE(0);
  const head = Buffer.from(body.subarray(36, 38)).readUInt16LE(0);
  const bump = body[38] ?? 0;
  const occupied = Math.min(total, LEDGER_CAPACITY);
  const start = total >= LEDGER_CAPACITY ? head % LEDGER_CAPACITY : 0;
  const entries: RingEntry[] = [];
  for (let i = 0; i < occupied; i++) {
    const idx = (start + i) % LEDGER_CAPACITY;
    const off = LEDGER_HEADER_SIZE + idx * ENTRY_SIZE;
    entries.push(decodeEntry(body.subarray(off, off + ENTRY_SIZE)));
  }
  return { address, mandate, total, head, bump, entries };
}

function decodeEntry(raw: Uint8Array): RingEntry {
  const kind = raw[64] ?? 0;
  const reason = raw[65] ?? 0;
  return {
    ts: readI64Le(raw, 0),
    amount: readU64Le(raw, 8),
    counterparty: new PublicKey(raw.subarray(16, 48)).toBase58(),
    nonce: readU64Le(raw, 48),
    suggestedOverride: readU64Le(raw, 56),
    kind,
    kindName: kindName(kind),
    reason,
    reasonText: reasonText(reason),
  };
}
