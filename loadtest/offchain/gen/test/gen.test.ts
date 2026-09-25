import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  CHARGE_IX_DISC,
  PAID_EVENT_DISC,
  REFUSED_EVENT_DISC,
} from "../../../../indexer/src/constants.js";
import {
  decodeEventsFromLogs,
  decodeIxData,
  decisionsFromTx,
} from "../../../../indexer/src/events.js";
import type { TxView } from "../../../../indexer/src/types.js";
import { run } from "../src/cli.js";
import { generate, toNdjsonLine, type Generated } from "../src/gen.js";
import { loadVetoIdl } from "../src/idl.js";

const idl = loadVetoIdl();
const PROGRAM = idl.programId;

function parseLine(line: string): TxView {
  const row = JSON.parse(line) as {
    signature: string;
    slot: number;
    blockTime: number | null;
    err: unknown;
    logs: string[];
    accountKeys: string[];
    instructions: { programId: string; accounts: string[]; data: string }[];
  };
  return {
    ...row,
    instructions: row.instructions.map((ix) => ({
      programId: ix.programId,
      accounts: ix.accounts,
      data: decodeIxData(ix.data),
    })),
  };
}

function serializeAll(batch: readonly Generated[]): { tx: TxView; intent: Generated["intent"] }[] {
  return batch.map((entry) => ({
    tx: parseLine(toNdjsonLine(entry.tx)),
    intent: entry.intent,
  }));
}

function captureStream(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

const CONFIG = {
  agents: 3,
  rules: 2,
  transactions: 200,
  paid: 60,
  refused: 30,
  override: 10,
  seed: 42,
};

test("every event in a generated batch decodes to the intended kind, reason and amount", () => {
  const rows = serializeAll(generate(CONFIG));
  let paid = 0;
  let refused = 0;
  let override = 0;
  let opened = 0;
  for (const { tx, intent } of rows) {
    const decisions = decisionsFromTx(tx, PROGRAM);
    if (intent.kind === "paid" || intent.kind === "refused") {
      assert.equal(decisions.length, 1, `tx ${tx.signature} should carry exactly one decision`);
      const d = decisions[0]!;
      assert.equal(d.kind, intent.kind);
      assert.equal(d.reason, intent.reason);
      assert.equal(d.amount, intent.amount);
      assert.equal(d.nonce, intent.nonce);
      assert.equal(d.mandate, intent.mandate);
      assert.equal(d.suggestedOverride, intent.suggestedOverride);
      assert.equal(d.counterparty, intent.destination);
      if (intent.kind === "paid") paid += 1;
      else refused += 1;
    } else {
      assert.deepEqual(decisions, [], `tx ${tx.signature} should carry no decision`);
      if (intent.kind === "override") override += 1;
      else opened += 1;
    }
  }
  assert.equal(paid + refused + override, CONFIG.transactions);
  assert.equal(opened, CONFIG.agents * CONFIG.rules);
  assert.ok(paid > 0 && refused > 0 && override > 0, "the mix should exercise all three kinds");
});

test("decodeEventsFromLogs sees the same events through the program frame filter", () => {
  for (const { tx, intent } of serializeAll(generate({ ...CONFIG, transactions: 20 }))) {
    if (intent.kind !== "paid" && intent.kind !== "refused") continue;
    const events = decodeEventsFromLogs(tx.logs, PROGRAM);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, intent.kind);
    assert.equal(events[0]!.amount, intent.amount);
    assert.equal(events[0]!.reason, intent.reason);
  }
});

test("the generator builds event and instruction bytes from the IDL discriminators", () => {
  assert.deepEqual([...idl.events.paid], [...PAID_EVENT_DISC]);
  assert.deepEqual([...idl.events.refused], [...REFUSED_EVENT_DISC]);
  assert.deepEqual([...idl.ixs.charge], [...CHARGE_IX_DISC]);
});

test("open_mandate instructions carry real borsh data behind the IDL discriminator", () => {
  const batch = generate({ ...CONFIG, transactions: 0 });
  assert.ok(batch.length > 0);
  for (const { tx, intent } of batch) {
    assert.equal(intent.kind, "open");
    if (intent.kind !== "open") continue;
    const ix = tx.instructions[0]!;
    assert.equal(ix.programId, PROGRAM);
    const data = ix.data;
    assert.deepEqual([...data.subarray(0, 8)], [...idl.ixs.openMandate]);
    let off = 8;
    const mandateId = data.readBigUInt64LE(off);
    off += 8;
    assert.ok(mandateId >= 1n);
    const agent = data.subarray(off, off + 32);
    off += 32;
    assert.ok(agent.some((b) => b !== 0));
    off += 32; // merchant
    assert.equal(data.readBigUInt64LE(off), intent.cap);
    off += 8;
    assert.equal(data.readBigUInt64LE(off), intent.perTxMax);
    off += 8;
    assert.equal(data.readBigInt64LE(off), intent.expiresAt);
    off += 8;
    const len = data.readUInt32LE(off);
    off += 4;
    assert.equal(data.subarray(off, off + len).toString("utf8"), intent.purpose);
    assert.equal(off + len, data.length, "no trailing bytes");
  }
});

test("grant_override instructions carry amount and nonce behind the IDL discriminator", () => {
  const batch = generate({ ...CONFIG, paid: 0, refused: 0, override: 1, transactions: 25 });
  const overrides = batch.filter((g) => g.intent.kind === "override");
  assert.ok(overrides.length > 0);
  for (const { tx, intent } of overrides) {
    if (intent.kind !== "override") continue;
    const data = tx.instructions[0]!.data;
    assert.equal(data.length, 24);
    assert.deepEqual([...data.subarray(0, 8)], [...idl.ixs.grantOverride]);
    assert.equal(data.readBigUInt64LE(8), intent.amount);
    assert.equal(data.readBigUInt64LE(16), intent.nonce);
  }
});

test("the same seed reproduces a byte-identical batch and a different seed does not", () => {
  const a = generate(CONFIG).map((g) => toNdjsonLine(g.tx)).join("\n");
  const b = generate(CONFIG).map((g) => toNdjsonLine(g.tx)).join("\n");
  const c = generate({ ...CONFIG, seed: 43 }).map((g) => toNdjsonLine(g.tx)).join("\n");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("the CLI writes newline-delimited JSON with one line per transaction", async () => {
  const { stream, text } = captureStream();
  await run(
    ["--agents", "2", "--rules", "3", "--transactions", "17", "--seed", "7"],
    stream,
  );
  const lines = text().trimEnd().split("\n");
  assert.equal(lines.length, 2 * 3 + 17);
  for (const line of lines) {
    const tx = parseLine(line);
    assert.equal(tx.err, null);
    assert.equal(tx.logs[0], `Program ${PROGRAM} invoke [1]`);
    assert.equal(tx.logs[tx.logs.length - 1], `Program ${PROGRAM} success`);
  }
});

test("the CLI rejects a mix with no positive weight", async () => {
  const { stream } = captureStream();
  await assert.rejects(
    run(["--transactions", "5", "--paid", "0", "--refused", "0", "--override", "0"], stream),
    /at least one of --paid, --refused, --override must be positive/,
  );
});
