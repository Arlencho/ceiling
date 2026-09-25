import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PriceFeed } from "./feed.js";
import {
  calendarDaysBetween,
  ECB_FX_URL,
  EcbFxFeed,
  fxFixingIsFresh,
  parseEcbDailyXml,
  type FxFailureKind,
  type FxSource,
} from "./fx.js";
import { JsonlJournal } from "./journal.js";
import {
  amountBaseUnits,
  amountBaseUnitsQuoted,
  amountBaseUnitsUsd,
  parseDecimalToScaled,
  sekPerKwhToScaled,
  usdPerSekDecimal,
} from "./money.js";
import { processWindow } from "./run.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test("fx document parsed from a fixture file", () => {
  const text = readFileSync(join(HERE, "fixtures", "eurofxref-daily.xml"), "utf8");
  const read = parseEcbDailyXml(text, ECB_FX_URL);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.quote.fixingDate, "2026-09-18");
  assert.equal(read.quote.usdRateScaled, parseDecimalToScaled("1.0854", 6));
  assert.equal(read.quote.sekRateScaled, parseDecimalToScaled("10.8540", 6));
  assert.equal(read.quote.usdRateScaled, 1_085_400n);
  assert.equal(read.quote.sekRateScaled, 10_854_000n);
  assert.equal(read.quote.sourceUrl, ECB_FX_URL);
});

test("fx parser accepts either quote style and either attribute order", () => {
  const text = `<Cube time="2026-09-18"><Cube rate="10.8540" currency="SEK"/><Cube currency="USD" rate="1.0854"/></Cube>`;
  const read = parseEcbDailyXml(text);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.quote.usdRateScaled, 1_085_400n);
  assert.equal(read.quote.sekRateScaled, 10_854_000n);
});

test("fx parser classifies a missing currency, a bad rate, and an unreadable document", () => {
  const missing = parseEcbDailyXml(`<Cube time='2026-09-18'><Cube currency='USD' rate='1.0854'/></Cube>`);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.kind, "missing_currency");

  const bad = parseEcbDailyXml(
    `<Cube time='2026-09-18'><Cube currency='USD' rate='1e-2'/><Cube currency='SEK' rate='10.8540'/></Cube>`,
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.kind, "malformed");

  const empty = parseEcbDailyXml("not xml");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.kind, "malformed");

  const twoDays = parseEcbDailyXml(
    `<Cube time='2026-09-18'></Cube><Cube time='2026-09-19'><Cube currency='USD' rate='1'/><Cube currency='SEK' rate='10'/></Cube>`,
  );
  assert.equal(twoDays.ok, false);
  if (!twoDays.ok) assert.equal(twoDays.kind, "malformed");
});

test("fx feed classifies a thrown fetch as unreachable and a non-2xx as http_error", async () => {
  const down = new EcbFxFeed((async () => {
    throw new Error("econnreset");
  }) as typeof fetch);
  const missed = await down.read(new Date("2026-09-21T00:00:00+02:00"));
  assert.equal(missed.ok, false);
  if (!missed.ok) assert.equal(missed.kind, "unreachable");

  const http = new EcbFxFeed((async () => new Response("no", { status: 503 })) as typeof fetch);
  const answered = await http.read(new Date("2026-09-21T00:00:00+02:00"));
  assert.equal(answered.ok, false);
  if (!answered.ok) {
    assert.equal(answered.kind, "http_error");
    assert.equal(answered.httpStatus, 503);
  }
});

test("Friday's fixing is fresh on Monday morning in Stockholm, and 5 calendar days is not", () => {
  assert.equal(calendarDaysBetween("1970-01-01", "1970-01-02"), 1);
  assert.equal(calendarDaysBetween("2024-02-28", "2024-03-01"), 2);
  assert.equal(calendarDaysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(calendarDaysBetween("2026-09-25", "2026-09-28"), 3);
  assert.equal(calendarDaysBetween("2026-09-24", "2026-09-28"), 4);
  assert.equal(calendarDaysBetween("2026-09-23", "2026-09-28"), 5);

  // 2026-09-27T22:30:00Z is Monday 00:30 in Stockholm, still Sunday on the UTC calendar.
  const mondayMorning = new Date("2026-09-27T22:30:00.000Z");
  assert.equal(fxFixingIsFresh("2026-09-25", mondayMorning), true);
  assert.equal(fxFixingIsFresh("2026-09-24", mondayMorning), true);
  assert.equal(fxFixingIsFresh("2026-09-23", mondayMorning), false);
  assert.equal(fxFixingIsFresh("2026-09-29", mondayMorning), false);
});

test("three known rows convert to the hand arithmetic", () => {
  // 50 kWh * 0.00892 SEK/kWh = 0.446 SEK.
  // USD per SEK = 1.0854 / 10.854 = 0.1 exactly.
  // 0.446 * 0.1 = 0.0446 USDC = 44600 base units at 6 decimals.
  // 50000 * 892000 * 1085400 * 10^6 / (10^3 * 10^8 * 10854000) = 44600.
  const row1 =
    (50_000n * 892_000n * 1_085_400n * 1_000_000n) / (1_000n * 100_000_000n * 10_854_000n);
  assert.equal(row1, 44_600n);
  assert.equal(
    amountBaseUnitsUsd({
      kwhMilli: 50_000n,
      sekPerKwhScaled: 892_000n,
      usdRateScaled: 1_085_400n,
      sekRateScaled: 10_854_000n,
      mintDecimals: 6,
    }),
    44_600n,
  );
  assert.equal(usdPerSekDecimal(1_085_400n, 10_854_000n), "0.10000000");

  // 6 kWh * 0.30 SEK/kWh = 1.8 SEK.
  // 1.1000 / 11.0000 = 0.1, so 1.8 * 0.1 = 0.18 USDC = 180000 base units.
  // 6000 * 30000000 * 1100000 * 10^6 / (10^3 * 10^8 * 11000000) = 180000.
  const row2 =
    (6_000n * 30_000_000n * 1_100_000n * 1_000_000n) / (1_000n * 100_000_000n * 11_000_000n);
  assert.equal(row2, 180_000n);
  assert.equal(
    amountBaseUnitsUsd({
      kwhMilli: 6_000n,
      sekPerKwhScaled: parseDecimalToScaled("0.30", 8),
      usdRateScaled: parseDecimalToScaled("1.1000", 6),
      sekRateScaled: parseDecimalToScaled("11.0000", 6),
      mintDecimals: 6,
    }),
    180_000n,
  );
  assert.equal(usdPerSekDecimal(1_100_000n, 11_000_000n), "0.10000000");

  // 6 kWh * 1.60 SEK/kWh = 9.6 SEK.
  // 9.6 * 1.1745 = 11.2752. 11.2752 / 10.9123 = 1.03325605... USDC.
  // Floor to 6 decimals is 1033256 base units.
  // 6000 * 160000000 * 1174500 * 10^6 / (10^3 * 10^8 * 10912300) = 1033256.
  const row3 =
    (6_000n * 160_000_000n * 1_174_500n * 1_000_000n) / (1_000n * 100_000_000n * 10_912_300n);
  assert.equal(row3, 1_033_256n);
  assert.equal(
    amountBaseUnitsUsd({
      kwhMilli: 6_000n,
      sekPerKwhScaled: 160_000_000n,
      usdRateScaled: 1_174_500n,
      sekRateScaled: 10_912_300n,
      mintDecimals: 6,
    }),
    1_033_256n,
  );
  assert.equal(usdPerSekDecimal(1_174_500n, 10_912_300n), "0.10763083");
});

test("money.ts and fx.ts do not parse a price or a rate with floats", () => {
  for (const name of ["money.ts", "fx.ts"]) {
    const src = readFileSync(join(HERE, name), "utf8");
    assert.equal(src.includes("parseFloat"), false, name);
    assert.equal(src.includes("toFixed"), false, name);
    assert.equal(/Number\s*\(/.test(src), false, name);
  }
});

test("USD off equals today for the existing base-unit fixtures", () => {
  const fixtures: Array<[string, bigint]> = [
    ["0.00418", 209_000n],
    ["0.00892", 446_000n],
    ["0.01039", 519_500n],
    ["0.12465", 6_232_500n],
    ["0.00011", 5_500n],
    ["0", 0n],
  ];
  for (const [sek, want] of fixtures) {
    const sekPerKwhScaled = sekPerKwhToScaled(sek);
    const today = amountBaseUnits({ kwhMilli: 50_000n, sekPerKwhScaled, mintDecimals: 6 });
    assert.equal(today, want, sek);
    for (const quoteCurrency of [undefined, "SEK" as const]) {
      const got = amountBaseUnitsQuoted({
        kwhMilli: 50_000n,
        sekPerKwhScaled,
        mintDecimals: 6,
        quoteCurrency,
        usdRateScaled: 1_085_400n,
        sekRateScaled: 10_854_000n,
      });
      assert.equal(got, today, `${sek} ${quoteCurrency ?? "unset"}`);
    }
  }
});

const HISTORIC = {
  at: new Date("2026-09-20T00:00:00+02:00"),
  window: {
    timeStart: "2026-09-20T00:00:00+02:00",
    timeEnd: "2026-09-20T00:15:00+02:00",
    sekPerKwh: "0.00892",
  },
};

function journal(): JsonlJournal {
  return new JsonlJournal(join(mkdtempSync(join(tmpdir(), "veto-fx-")), "decisions.jsonl"));
}

function feedOf(sek: string, start: string): PriceFeed {
  return {
    async getWindow() {
      return {
        timeStart: start,
        timeEnd: start.replace("00:00", "00:15"),
        sekPerKwh: sek,
      };
    },
  };
}

test("USD off submits the same base units as today and does not read a rate", async () => {
  let fxCalls = 0;
  const fx: FxSource = {
    async read() {
      fxCalls += 1;
      throw new Error("fx must not be read when quoting is off");
    },
  };
  const paid = async () => ({
    decision: "paid" as const,
    reason: "ok",
    reasonCode: 0,
    suggestedOverride: null,
    signature: "sig",
  });

  const unset = journal();
  const unsetResult = await processWindow({
    at: HISTORIC.at,
    feed: feedOf(HISTORIC.window.sekPerKwh, HISTORIC.window.timeStart),
    journal: unset,
    submit: paid,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    fx,
  });
  const sek = journal();
  const sekResult = await processWindow({
    at: HISTORIC.at,
    feed: feedOf(HISTORIC.window.sekPerKwh, HISTORIC.window.timeStart),
    journal: sek,
    submit: paid,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    quoteCurrency: "SEK",
    fx,
  });

  assert.equal(unsetResult, "submitted");
  assert.equal(sekResult, "submitted");
  assert.equal(fxCalls, 0);
  const unsetRow = unset.load()[0];
  const sekRow = sek.load()[0];
  assert.equal(unsetRow?.amount, "446000");
  assert.equal(sekRow?.amount, "446000");
  assert.equal(unsetRow?.amount, sekRow?.amount);
  assert.equal(Object.hasOwn(unsetRow ?? {}, "quote_currency"), false);
  assert.equal(Object.hasOwn(sekRow ?? {}, "quote_currency"), false);
});

const MONDAY = new Date("2026-09-21T00:00:00+02:00");
const MONDAY_START = "2026-09-21T00:00:00+02:00";

function rates(date: string): FxSource {
  return {
    async read() {
      return {
        ok: true,
        quote: {
          usdRateScaled: 1_085_400n,
          sekRateScaled: 10_854_000n,
          fixingDate: date,
          sourceUrl: ECB_FX_URL,
        },
      };
    },
  };
}

test("a stale fixing writes one gap and the slot stays due", async () => {
  const book = journal();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    return {
      decision: "paid" as const,
      reason: "ok",
      reasonCode: 0,
      suggestedOverride: null,
      signature: "sig",
    };
  };
  const args = {
    at: MONDAY,
    feed: feedOf("0.00892", MONDAY_START),
    journal: book,
    submit,
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    quoteCurrency: "USD" as const,
  };

  const stale = await processWindow({ ...args, fx: rates("2026-09-16") });
  assert.equal(stale, "gap");
  assert.equal(calls, 0);
  assert.equal(book.hasNonce(1789941600n), false);
  const gap = book.load()[0];
  assert.equal(gap?.decision, "gap");
  assert.equal(gap?.reason, "fx rate stale (2026-09-16)");
  assert.equal(gap?.quote_currency, "USD");
  assert.equal(gap?.fx_date, "2026-09-16");
  assert.equal(gap?.fx_rate, "0.10000000");
  assert.equal(gap?.amount, "0");

  const again = await processWindow({ ...args, fx: rates("2026-09-16") });
  assert.equal(again, "gap");
  assert.equal(book.load().length, 1, "one gap row per stale fixing");
  assert.equal(book.hasNonce(1789941600n), false);

  const lines: string[] = [];
  const paid = await processWindow({
    ...args,
    fx: rates("2026-09-18"),
    log: (line) => lines.push(line),
  });
  assert.equal(paid, "submitted");
  assert.equal(calls, 1);
  assert.equal(book.hasNonce(1789941600n), true);
  const row = book.load()[1];
  assert.equal(row?.decision, "paid");
  assert.equal(row?.amount, "44600");
  assert.equal(row?.quote_currency, "USD");
  assert.equal(row?.fx_rate, "0.10000000");
  assert.equal(row?.fx_date, "2026-09-18");
  assert.equal(row?.fx_source, ECB_FX_URL);
  const log = lines.find((line) => line.startsWith("paid "));
  assert.ok(log !== undefined);
  assert.ok(log.includes("amount=44600"));
  assert.ok(log.includes("sek=0.00892"));
  assert.ok(log.includes("fx=0.10000000"));
  assert.ok(log.includes("fx_date=2026-09-18"));
});

test("an unreachable fx source writes a gap and submits nothing", async () => {
  const kinds: FxFailureKind[] = ["unreachable", "http_error", "malformed", "missing_currency"];
  for (const kind of kinds) {
    const book = journal();
    let calls = 0;
    const result = await processWindow({
      at: MONDAY,
      feed: feedOf("0.00892", MONDAY_START),
      journal: book,
      submit: async () => {
        calls += 1;
        throw new Error("must not submit");
      },
      kwhMilli: 50_000n,
      mintDecimals: 6,
      log: () => {},
      feedAttempts: 1,
      feedRetryMs: 0,
      quoteCurrency: "USD",
      fx: {
        async read() {
          return { ok: false, kind, sourceUrl: ECB_FX_URL, httpStatus: kind === "http_error" ? 503 : null };
        },
      },
    });
    assert.equal(result, "gap", kind);
    assert.equal(calls, 0, kind);
    assert.equal(book.hasNonce(1789941600n), false, kind);
    const row = book.load()[0];
    assert.equal(row?.reason, "fx unavailable", kind);
    assert.equal(row?.quote_currency, "USD", kind);
    assert.equal(row?.fx_rate, null, kind);
    assert.equal(row?.fx_date, null, kind);
    assert.equal(row?.fx_source, ECB_FX_URL, kind);
    assert.equal(row?.amount, "0", kind);
  }
});

test("a refused USD charge records the rate that was read", async () => {
  const book = journal();
  const result = await processWindow({
    at: MONDAY,
    feed: feedOf("0.00892", MONDAY_START),
    journal: book,
    submit: async (amount) => {
      assert.equal(amount, 44_600n);
      return {
        decision: "refused" as const,
        reason: "over per-payment maximum",
        reasonCode: 5,
        suggestedOverride: null,
        signature: "refuse-sig",
      };
    },
    kwhMilli: 50_000n,
    mintDecimals: 6,
    log: () => {},
    feedAttempts: 1,
    feedRetryMs: 0,
    quoteCurrency: "USD",
    fx: rates("2026-09-18"),
  });
  assert.equal(result, "submitted");
  const row = book.load()[0];
  assert.equal(row?.decision, "refused");
  assert.equal(row?.amount, "44600");
  assert.equal(row?.quote_currency, "USD");
  assert.equal(row?.fx_rate, "0.10000000");
  assert.equal(row?.fx_date, "2026-09-18");
  assert.equal(row?.fx_source, ECB_FX_URL);
});

test("an older journal row without fx fields still loads", () => {
  const path = join(mkdtempSync(join(tmpdir(), "veto-fx-old-")), "decisions.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({
      ts: "2026-09-20T00:00:00.000Z",
      window_start: "2026-09-20T00:00:00+02:00",
      window_end: "2026-09-20T00:15:00+02:00",
      sek_per_kwh: "0.00892",
      kwh_milli: "50000",
      amount: "446000",
      nonce: "1789855200",
      decision: "paid",
      reason: "ok",
      reason_code: 0,
      signature: "sig",
      suggested_override: null,
    })}\n`,
  );
  const book = new JsonlJournal(path);
  const row = book.load()[0];
  assert.equal(row?.amount, "446000");
  assert.equal(row?.decision, "paid");
  assert.equal(row?.quote_currency, undefined);
  assert.equal(book.hasNonce(1789855200n), true);
});
