import type { Location } from './decode/index.js';

export interface IngestLocation {
  signature: string; slot: string; block_time: Date;
  instruction_index: number; inner_index: number;
}

/**
 * Convert a decoded instruction location into the ingest row's identity
 * fields. The decoder reports a numeric slot, a nullable Unix-second
 * timestamp, and null for a top-level instruction; the index stores a string
 * slot, a timestamptz block_time, and -1 for a top-level instruction.
 *
 * getTransaction can return a null blockTime. The partition key cannot be
 * null, so the caller resolves the slot's block time (getBlockTime or a block
 * header) and passes it as slotTime. Without either timestamp the record is
 * refused rather than stored under a fabricated time.
 */
export function ingestLocation(record: Location, slotTime?: number | null): IngestLocation {
  const seconds = record.timestamp ?? slotTime ?? null;
  if (seconds === null) {
    throw new Error(`No block time for ${record.signature}: pass the slot's time when getTransaction returns null`);
  }
  return {
    signature: record.signature,
    slot: String(record.slot),
    block_time: new Date(seconds * 1000),
    instruction_index: record.instructionIndex,
    inner_index: record.innerInstructionIndex ?? -1,
  };
}
