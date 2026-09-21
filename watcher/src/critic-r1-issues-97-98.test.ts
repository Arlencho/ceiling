// Critic fixture, PR 100 round 1, issues 97 and 98.
//
// 97: every quoted price shape beyond the 35 rows in critic-r1-feed-parity is
// pinned here as the branch classifies it. Driven side by side against main at
// 887ef1d: a quoted decimal keeps its source text byte for byte (integer, sign,
// scientific, a 24 digit mantissa); a quoted token that is padded or is not a
// decimal is unreadable, where main reported ok and handed the text through.
//
// 98: the repair walk is counted on a ring of six with a history of seven
// (one nonce older than the ring). Missing one in the middle reads down to it
// and stops; missing two scattered reads down to the older one; missing
// everything, or no hasNonce, reads all seven and names every row including
// the one the ring lost. A nonce refused and later paid resolves to the
// payment whether or not the payment is the newest transaction. A failed
// newest transaction is skipped, a page boundary is crossed only when the
// missing nonce is past it, and a nonce the history never shows keeps the
// walk reading to the end and keeps its ring row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { EnergySpotFeed, isMalformedDayBody, parseFeedBody } from "./feed.js";
import { chainDecisionToRow, fetchChainDecisions, RECOVERED_SIGNATURE } from "./journalRepair.js";

// ---------------------------------------------------------------- issue 97

const W10 = { start: "2026-09-20T10:00:00+02:00", end: "2026-09-20T10:15:00+02:00" };
const AT = new Date("2026-09-20T10:05:00+02:00");
const q = (s: string) => `[{"SEK_per_kWh":${JSON.stringify(s)},"time_start":"${W10.start}","time_end":"${W10.end}"}]`;

async function classify(body: string) {
  const feed = new EnergySpotFeed(async () => new Response(body, { status: 200 }));
  const read = await feed.readWindow(AT);
  return {
    status: read.status,
    sek: read.window?.sekPerKwh ?? null,
    malformed: isMalformedDayBody(body),
    windows: parseFeedBody(body).map((w) => w.sekPerKwh),
  };
}

// A quoted decimal keeps its source text. Main at 887ef1d gave the same text.
const quotedDecimals = [
  "1",
  "0",
  "-0.5",
  "+0.5",
  ".5",
  "5.",
  "0.123456789012345678901234",
  "123456789012345678901234",
  "1e-05",
  "1E+2",
  "1.5e-3",
  "1e5",
];

// Padded or not a decimal. Main at 887ef1d reported ok and handed the text
// through; the branch reports malformed with no window.
const quotedNotDecimals = [
  " 0.30722 ",
  "abc",
  "1e-05 ",
  "1e",
  "\t0.5",
  "0.5\n",
  " 0.5",
  "1 000",
  "1,5",
  "0x10",
  "NaN",
  "Infinity",
  "-",
  ".",
  "--1",
  "1.2.3",
  "١",
];

test("critic r1 issue 97: a quoted decimal keeps its source text byte for byte", async () => {
  for (const sek of quotedDecimals) {
    const got = await classify(q(sek));
    assert.deepEqual(got, { status: "ok", sek, malformed: false, windows: [sek] }, JSON.stringify(sek));
  }
});

test("critic r1 issue 97: a quoted token that is padded or not a decimal is unreadable", async () => {
  for (const sek of quotedNotDecimals) {
    const got = await classify(q(sek));
    assert.deepEqual(got, { status: "malformed", sek: null, malformed: true, windows: [] }, JSON.stringify(sek));
  }
});

test("critic r1 issue 97: an unreadable quoted price in another entry does not touch this window", async () => {
  const body = `[{"SEK_per_kWh":0.30722,"time_start":"${W10.start}","time_end":"${W10.end}"},{"SEK_per_kWh":"abc","time_start":"${W10.end}","time_end":"2026-09-20T10:30:00+02:00"}]`;
  const got = await classify(body);
  assert.deepEqual(got, { status: "ok", sek: "0.30722", malformed: false, windows: ["0.30722"] });
});

test("critic r1 issue 97: a quoted price with a unicode escape is read as parsed, not as source", async () => {
  const body = `[{"SEK_per_kWh":"0.3\\u0030","time_start":"${W10.start}","time_end":"${W10.end}"}]`;
  const got = await classify(body);
  assert.deepEqual(got, { status: "ok", sek: "0.30", malformed: false, windows: ["0.30"] });
});

// ---------------------------------------------------------------- issue 98

const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const CHARGE_DISC = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);

function ledgerBytes(entries: Array<{ kind: number; nonce: bigint; amount: bigint; ts: bigint; reason: number }>): Buffer {
  const data = Buffer.alloc(8 + 40 + 32 * 72);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(entries.length, 8 + 32);
  data.writeUInt16LE(entries.length, 8 + 36);
  for (let i = 0; i < entries.length; i++) {
    const off = 8 + 40 + i * 72;
    const e = entries[i]!;
    data.writeBigInt64LE(e.ts, off);
    data.writeBigUInt64LE(e.amount, off + 8);
    data.writeBigUInt64LE(e.nonce, off + 48);
    data[off + 64] = e.kind;
    data[off + 65] = e.reason;
  }
  return data;
}

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

const programId = new PublicKey(Buffer.alloc(32, 9));
const owner = new PublicKey(Buffer.alloc(32, 10));

const PAID = (amount: bigint) => [`Program log: VETO PAID amount=${amount.toString()}`];
const REFUSED = (amount: bigint) => [
  `Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=${amount.toString()} per_tx_max=500000 remaining=1 override_to_clear=${amount.toString()}`,
];

type Hist = { signature: string; nonce: bigint; amount: bigint; blockTime: number; logs: string[]; err?: unknown };

function chargeTx(h: Hist) {
  return {
    slot: 1,
    blockTime: h.blockTime,
    transaction: {
      message: {
        staticAccountKeys: [PublicKey.default, PublicKey.default, programId],
        compiledInstructions: [
          { programIdIndex: 2, accountKeyIndexes: [] as number[], data: Buffer.concat([CHARGE_DISC, u64(h.amount), u64(h.nonce)]) },
        ],
      },
    },
    meta: { err: null, logMessages: h.logs, loadedAddresses: { writable: [] as PublicKey[], readonly: [] as PublicKey[] } },
  };
}

const HOUR = 3600n;
const N0 = 1789851600n;
const N1 = N0 + HOUR;
const N2 = N0 + 2n * HOUR;
const N3 = N0 + 3n * HOUR;
const N4 = N0 + 4n * HOUR;
const N5 = N0 + 5n * HOUR;
const N6 = N0 + 6n * HOUR;

const RING6 = ledgerBytes([
  { kind: 1, nonce: N1, amount: 100n, ts: N1 + 5n, reason: 0 },
  { kind: 2, nonce: N2, amount: 200n, ts: N2 + 5n, reason: 5 },
  { kind: 1, nonce: N3, amount: 300n, ts: N3 + 5n, reason: 0 },
  { kind: 1, nonce: N4, amount: 400n, ts: N4 + 5n, reason: 0 },
  { kind: 2, nonce: N5, amount: 500n, ts: N5 + 5n, reason: 5 },
  { kind: 1, nonce: N6, amount: 600n, ts: N6 + 5n, reason: 0 },
]);

// Newest first. N0 is older than the ring holds.
const HISTORY7: Hist[] = [
  { signature: "sig-n6", nonce: N6, amount: 600n, blockTime: Number(N6 + 5n), logs: PAID(600n) },
  { signature: "sig-n5", nonce: N5, amount: 500n, blockTime: Number(N5 + 5n), logs: REFUSED(500n) },
  { signature: "sig-n4", nonce: N4, amount: 400n, blockTime: Number(N4 + 5n), logs: PAID(400n) },
  { signature: "sig-n3", nonce: N3, amount: 300n, blockTime: Number(N3 + 5n), logs: PAID(300n) },
  { signature: "sig-n2", nonce: N2, amount: 200n, blockTime: Number(N2 + 5n), logs: REFUSED(200n) },
  { signature: "sig-n1", nonce: N1, amount: 100n, blockTime: Number(N1 + 5n), logs: PAID(100n) },
  { signature: "sig-n0", nonce: N0, amount: 50n, blockTime: Number(N0 + 5n), logs: PAID(50n) },
];

function run(history: Hist[], ledger: Buffer, hasNonce?: (nonce: bigint) => boolean) {
  const calls = { sigs: 0, read: [] as string[] };
  const connection = {
    async getAccountInfo() {
      return { data: ledger };
    },
    async getSignaturesForAddress(_addr: PublicKey, config?: { limit?: number; before?: string }) {
      calls.sigs += 1;
      const limit = config?.limit ?? history.length;
      let from = 0;
      if (config?.before !== undefined) {
        const at = history.findIndex((h) => h.signature === config.before);
        from = at === -1 ? history.length : at + 1;
      }
      return history.slice(from, from + limit).map((h) => ({ signature: h.signature, err: h.err ?? null, blockTime: h.blockTime }));
    },
    async getTransaction(signature: string) {
      calls.read.push(signature);
      const h = history.find((row) => row.signature === signature);
      return h === undefined ? null : chargeTx(h);
    },
  };
  const entries = fetchChainDecisions({
    connection,
    programId,
    owner,
    mandateId: 1n,
    ...(hasNonce === undefined ? {} : { hasNonce }),
  });
  return { calls, rows: entries.then((e) => e.map(chainDecisionToRow)) };
}

const holds = (...nonces: bigint[]) => (nonce: bigint) => nonces.includes(nonce);

test("critic r1 issue 98: missing one nonce in the middle reads down to it and stops", async () => {
  const { calls, rows } = run(HISTORY7, RING6, holds(N1, N2, N4, N5, N6));
  const got = await rows;
  assert.deepEqual(calls.read, ["sig-n6", "sig-n5", "sig-n4", "sig-n3"]);
  assert.equal(calls.sigs, 1);
  assert.deepEqual(got.find((r) => r.nonce === N3.toString())?.signature, "sig-n3");
});

test("critic r1 issue 98: missing two scattered nonces reads down to the older one and finds both", async () => {
  const { calls, rows } = run(HISTORY7, RING6, holds(N1, N3, N4, N6));
  const got = await rows;
  assert.deepEqual(calls.read, ["sig-n6", "sig-n5", "sig-n4", "sig-n3", "sig-n2"]);
  assert.deepEqual(
    got.filter((r) => r.nonce === N2.toString() || r.nonce === N5.toString()).map((r) => [r.nonce, r.decision, r.signature]),
    [
      [N2.toString(), "refused", "sig-n2"],
      [N5.toString(), "refused", "sig-n5"],
    ],
  );
});

test("critic r1 issue 98: missing everything rebuilds every row with its own signature, including the one the ring lost", async () => {
  for (const hasNonce of [() => false, undefined]) {
    const { calls, rows } = run(HISTORY7, RING6, hasNonce);
    const got = await rows;
    assert.equal(calls.read.length, 7, "every transaction in the history is read");
    assert.deepEqual(
      got.map((r) => [r.nonce, r.decision, r.signature]),
      [
        [N0.toString(), "paid", "sig-n0"],
        [N1.toString(), "paid", "sig-n1"],
        [N2.toString(), "refused", "sig-n2"],
        [N3.toString(), "paid", "sig-n3"],
        [N4.toString(), "paid", "sig-n4"],
        [N5.toString(), "refused", "sig-n5"],
        [N6.toString(), "paid", "sig-n6"],
      ],
    );
    assert.equal(got.some((r) => r.signature === RECOVERED_SIGNATURE), false);
  }
});

test("critic r1 issue 98: a nonce refused then paid resolves to the payment, in either position", async () => {
  const paidN2: Hist = { signature: "sig-n2-paid", nonce: N2, amount: 200n, blockTime: Number(N2 + 900n), logs: PAID(200n) };
  // Payment newest of all: one read.
  const newest = [paidN2, ...HISTORY7];
  const a = run(newest, RING6, holds(N1, N3, N4, N5, N6));
  const aRows = await a.rows;
  assert.deepEqual(a.calls.read, ["sig-n2-paid"]);
  assert.deepEqual(aRows.find((r) => r.nonce === N2.toString())?.decision, "paid");
  assert.deepEqual(aRows.find((r) => r.nonce === N2.toString())?.signature, "sig-n2-paid");
  // Payment behind newer nonces: the walk reads down to it, stops there, and
  // never reads the older refusal.
  const behind = [HISTORY7[0]!, HISTORY7[1]!, paidN2, ...HISTORY7.slice(2)];
  const b = run(behind, RING6, holds(N1, N3, N4, N5, N6));
  const bRows = await b.rows;
  assert.deepEqual(b.calls.read, ["sig-n6", "sig-n5", "sig-n2-paid"]);
  assert.deepEqual(bRows.find((r) => r.nonce === N2.toString())?.decision, "paid");
  assert.deepEqual(bRows.find((r) => r.nonce === N2.toString())?.signature, "sig-n2-paid");
});

test("critic r1 issue 98: a failed newest transaction for the missing nonce is skipped, not counted as found", async () => {
  const failed: Hist = { signature: "sig-n6-failed", nonce: N6, amount: 600n, blockTime: Number(N6 + 9n), logs: [], err: { InstructionError: [0, "Custom"] } };
  const { calls, rows } = run([failed, ...HISTORY7], RING6, holds(N1, N2, N3, N4, N5));
  const got = await rows;
  assert.deepEqual(calls.read, ["sig-n6"]);
  assert.deepEqual(got.find((r) => r.nonce === N6.toString())?.signature, "sig-n6");
});

test("critic r1 issue 98: a page boundary is crossed only when the missing nonce lies past it", async () => {
  // 250 filler transactions newer than the ring, then the ring history.
  const filler: Hist[] = Array.from({ length: 250 }, (_, i) => {
    const nonce = N6 + HOUR * BigInt(250 - i);
    return { signature: `sig-f${i}`, nonce, amount: 1n, blockTime: Number(nonce + 5n), logs: PAID(1n) };
  });
  const long = [...filler, ...HISTORY7];
  // The ring holds the three newest filler nonces (listing indices 0, 1, 2)
  // and N6 (listing index 250).
  const ring = ledgerBytes([
    ...[250, 249, 248].map((k) => {
      const nonce = N6 + HOUR * BigInt(k);
      return { kind: 1, nonce, amount: 1n, ts: nonce + 5n, reason: 0 };
    }),
    { kind: 1, nonce: N6, amount: 600n, ts: N6 + 5n, reason: 0 },
  ]);
  // Missing N6 sits at index 250 of the listing: two pages, 251 reads.
  const far = run(long, ring, holds(N6 + HOUR * 250n, N6 + HOUR * 249n, N6 + HOUR * 248n));
  const farRows = await far.rows;
  assert.equal(far.calls.sigs, 2);
  assert.equal(far.calls.read.length, 251);
  assert.equal(far.calls.read.at(-1), "sig-n6");
  assert.deepEqual(farRows.find((r) => r.nonce === N6.toString())?.signature, "sig-n6");
  // Missing the filler nonce at index 2: one page, three reads.
  const near = run(long, ring, holds(N6, N6 + HOUR * 250n, N6 + HOUR * 249n));
  await near.rows;
  assert.equal(near.calls.sigs, 1);
  assert.deepEqual(near.calls.read, ["sig-f0", "sig-f1", "sig-f2"]);
});

test("critic r1 issue 98: a missing nonce the history never shows keeps the walk reading to the end and keeps its ring row", async () => {
  const withoutN3 = HISTORY7.filter((h) => h.nonce !== N3);
  const { calls, rows } = run(withoutN3, RING6, holds(N1, N2, N4, N5, N6));
  const got = await rows;
  assert.equal(calls.read.length, withoutN3.length, "every transaction read, nothing found to stop on");
  assert.deepEqual(
    got.find((r) => r.nonce === N3.toString()),
    got.find((r) => r.nonce === N3.toString()) && { ...got.find((r) => r.nonce === N3.toString())!, signature: RECOVERED_SIGNATURE },
  );
  assert.equal(got.find((r) => r.nonce === N3.toString())?.decision, "paid");
});
