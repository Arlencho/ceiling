import assert from "node:assert/strict";
import { test } from "node:test";
import { EnergySpotFeed, feedUrlFor, isMalformedDayBody, parseFeedBody, plainDecimal, windowContaining } from "./feed.js";

const BODY = `[
  {"SEK_per_kWh": 0.00892, "EUR_per_kWh": 0.00079, "EXR": 11.290555, "time_start": "2026-09-20T00:00:00+02:00", "time_end": "2026-09-20T00:15:00+02:00"},
  {"SEK_per_kWh": 0.00418, "EUR_per_kWh": 0.00037, "EXR": 11.290555, "time_start": "2026-09-20T04:15:00+02:00", "time_end": "2026-09-20T04:30:00+02:00"}
]`;

test("parseFeedBody keeps SEK_per_kWh as the original decimal string", () => {
  const windows = parseFeedBody(BODY);
  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.sekPerKwh, "0.00892");
  assert.equal(windows[1]?.sekPerKwh, "0.00418");
});

test("windowContaining matches the 15-minute slot that holds the instant", () => {
  const windows = parseFeedBody(BODY);
  const hit = windowContaining(windows, new Date("2026-09-20T04:15:00+02:00"));
  assert.equal(hit?.sekPerKwh, "0.00418");
  const miss = windowContaining(windows, new Date("2026-09-20T12:00:00+02:00"));
  assert.equal(miss, null);
});

test("feedUrlFor uses the Stockholm calendar date", () => {
  assert.equal(
    feedUrlFor(new Date("2026-09-20T00:00:00+02:00")),
    "https://www.elprisetjustnu.se/api/v1/prices/2026/09-20_SE3.json",
  );
  assert.equal(
    feedUrlFor(new Date("2026-09-19T23:00:00Z")),
    "https://www.elprisetjustnu.se/api/v1/prices/2026/09-20_SE3.json",
  );
});

test("EnergySpotFeed returns null on a failed fetch rather than inventing a price", async () => {
  const feed = new EnergySpotFeed(async () => new Response("nope", { status: 503 }));
  const got = await feed.getWindow(new Date("2026-09-20T00:00:00+02:00"));
  assert.equal(got, null);
});

test("EnergySpotFeed reads a window from the public JSON shape", async () => {
  const feed = new EnergySpotFeed(async () => new Response(BODY, { status: 200 }));
  const got = await feed.getWindow(new Date("2026-09-20T00:05:00+02:00"));
  assert.equal(got?.sekPerKwh, "0.00892");
  assert.equal(got?.timeStart, "2026-09-20T00:00:00+02:00");
});

// Regression, found in production on 2026-09-20. The feed emits scientific
// notation for very cheap windows, the strict numeric pattern dropped those
// entries whole, and the 12:00 cadence slot vanished on two separate clusters
// before anyone looked. The bias is what makes it serious: scientific notation
// appears when the price is tiny, so the windows lost were the ones that would
// have paid.
test("an entry whose EUR field is in scientific notation is still read", () => {
  const body = JSON.stringify([
    {
      SEK_per_kWh: 0.00011,
      EUR_per_kWh: 1e-5,
      EXR: 11.290555,
      time_start: "2026-09-20T12:00:00+02:00",
      time_end: "2026-09-20T12:15:00+02:00",
    },
  ]);
  const windows = parseFeedBody(body);
  assert.equal(windows.length, 1, "the entry must not be dropped");
  assert.equal(windows[0]?.sekPerKwh, "0.00011");
});

test("a scientific price expands to a plain decimal without touching a float", () => {
  assert.equal(plainDecimal("1e-05"), "0.00001");
  assert.equal(plainDecimal("1.5e-4"), "0.00015");
  assert.equal(plainDecimal("2e3"), "2000");
  assert.equal(plainDecimal("-3.25e-2"), "-0.0325");
  assert.equal(plainDecimal("0.00429"), "0.00429", "a plain decimal passes through");
});

test("parseFeedBody keeps a scientific SEK price as the source text", () => {
  const body = `[{"SEK_per_kWh":1e-05,"EUR_per_kWh":1e-05,"EXR":11.17,"time_start":"2026-09-20T10:00:00+02:00","time_end":"2026-09-20T10:15:00+02:00"}]`;
  const windows = parseFeedBody(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.sekPerKwh, "1e-05");
});

test("a 200 body with no current hour is missing_window, not unreachable", async () => {
  const body = `[{"SEK_per_kWh":0.1,"EUR_per_kWh":0.01,"EXR":11,"time_start":"2026-09-20T00:00:00+02:00","time_end":"2026-09-20T00:15:00+02:00"}]`;
  const feed = new EnergySpotFeed(async () => new Response(body, { status: 200 }));
  const read = await feed.readWindow(new Date("2026-09-20T10:05:00+02:00"));
  assert.equal(read.status, "missing_window");
  assert.equal(read.refreshFailed, false);
  assert.equal(read.window, null);
});

test("a 200 body that is not a JSON array is malformed, not unreachable", async () => {
  const feed = new EnergySpotFeed(async () => new Response(`{"oops":true}`, { status: 200 }));
  const read = await feed.readWindow(new Date("2026-09-20T00:05:00+02:00"));
  assert.equal(read.status, "malformed");
  assert.equal(read.window, null);
});

test("a later failed fetch keeps the cached day file and reports the failed refresh", async () => {
  let calls = 0;
  const feed = new EnergySpotFeed(async () => {
    calls += 1;
    if (calls === 1) return new Response(BODY, { status: 200 });
    throw new TypeError("fetch failed");
  });
  const at = new Date("2026-09-20T00:05:00+02:00");
  const first = await feed.readWindow(at);
  assert.equal(first.status, "ok");
  const second = await feed.readWindow(new Date(at.getTime() + 60_000));
  assert.equal(calls, 2);
  assert.equal(second.status, "ok");
  assert.equal(second.refreshFailed, true);
  assert.equal(second.window?.sekPerKwh, "0.00892");
  assert.ok(first.readAt !== null && second.readAt !== null);
  assert.equal(second.readAt.getTime(), first.readAt.getTime());
});

test("a reordered entry is read by field name", () => {
  const body =
    '[{"time_start":"2026-09-20T10:00:00+02:00","time_end":"2026-09-20T10:15:00+02:00","SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17}]';
  const windows = parseFeedBody(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.sekPerKwh, "0.30722");
  assert.equal(windows[0]?.timeStart, "2026-09-20T10:00:00+02:00");
  assert.equal(windows[0]?.timeEnd, "2026-09-20T10:15:00+02:00");
});

test("a quoted SEK price is read as the source text", () => {
  const body =
    '[{"SEK_per_kWh":"0.30722","EUR_per_kWh":0.027,"EXR":11.17,"time_start":"2026-09-20T10:00:00+02:00","time_end":"2026-09-20T10:15:00+02:00"}]';
  const windows = parseFeedBody(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.sekPerKwh, "0.30722");
});

test("a quoted scientific SEK price stays the source text", () => {
  const body =
    '[{"SEK_per_kWh":"1e-05","EUR_per_kWh":"1e-05","EXR":11.17,"time_start":"2026-09-20T10:00:00+02:00","time_end":"2026-09-20T10:15:00+02:00"}]';
  const windows = parseFeedBody(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.sekPerKwh, "1e-05");
});

test("a reordered day file with a quoted price is a readable window, not malformed", async () => {
  const body =
    '[{"EXR":11.17,"time_end":"2026-09-20T10:15:00+02:00","SEK_per_kWh":"0.30722","time_start":"2026-09-20T10:00:00+02:00","EUR_per_kWh":0.027}]';
  const feed = new EnergySpotFeed(async () => new Response(body, { status: 200 }));
  const read = await feed.readWindow(new Date("2026-09-20T10:05:00+02:00"));
  assert.equal(read.status, "ok");
  assert.equal(read.window?.sekPerKwh, "0.30722");
});

test("a body that is not JSON is malformed, distinct from a missing hour", async () => {
  const at = new Date("2026-09-20T10:05:00+02:00");
  const unreadable = new EnergySpotFeed(async () => new Response("<html>rate limited</html>", { status: 200 }));
  const noHour = new EnergySpotFeed(
    async () =>
      new Response(
        '[{"SEK_per_kWh":0.1,"EUR_per_kWh":0.01,"EXR":11,"time_start":"2026-09-20T00:00:00+02:00","time_end":"2026-09-20T00:15:00+02:00"}]',
        { status: 200 },
      ),
  );
  const bad = await unreadable.readWindow(at);
  const missing = await noHour.readWindow(at);
  assert.equal(bad.status, "malformed");
  assert.equal(missing.status, "missing_window");
  assert.equal(isMalformedDayBody("<html>rate limited</html>"), true);
  assert.equal(
    isMalformedDayBody(
      '[{"SEK_per_kWh":0.1,"EUR_per_kWh":0.01,"EXR":11,"time_start":"2026-09-20T00:00:00+02:00","time_end":"2026-09-20T00:15:00+02:00"}]',
    ),
    false,
  );
});

test("a JSON body of the wrong shape is malformed, distinct from a missing hour", async () => {
  const at = new Date("2026-09-20T10:05:00+02:00");
  const objectBody = new EnergySpotFeed(async () => new Response('{"oops":true}', { status: 200 }));
  const otherKeys = new EnergySpotFeed(
    async () =>
      new Response(
        '[{"price_sek":0.30722,"from":"2026-09-20T10:00:00+02:00","to":"2026-09-20T10:15:00+02:00"}]',
        { status: 200 },
      ),
  );
  const objectRead = await objectBody.readWindow(at);
  const otherKeysRead = await otherKeys.readWindow(at);
  assert.equal(objectRead.status, "malformed");
  assert.equal(otherKeysRead.status, "malformed");
  assert.notEqual(objectRead.status, "missing_window");
  assert.notEqual(otherKeysRead.status, "missing_window");
});

test("every window in a real feed body is read, not most of them", () => {
  const rows = [];
  for (let i = 0; i < 96; i += 1) {
    const cheap = i % 24 === 0;
    rows.push({
      SEK_per_kWh: cheap ? 0.00011 : 0.05,
      EUR_per_kWh: cheap ? 1e-5 : 0.0044,
      EXR: 11.290555,
      time_start: `2026-09-20T${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00+02:00`,
      time_end: `2026-09-20T${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:01+02:00`,
    });
  }
  assert.equal(parseFeedBody(JSON.stringify(rows)).length, 96);
});

// Round 1 critic fixtures for #72: every shape a third party might send, and
// what the classifier must say about each. The terminal screen keys off the
// status word, so the rows below pin that the outcomes stay distinguishable.

const AT_10_05 = new Date("2026-09-20T10:05:00+02:00");
const W10 = { start: "2026-09-20T10:00:00+02:00", end: "2026-09-20T10:15:00+02:00" };

test("every body shape a third party might send classifies as documented", async () => {
  const rows: Array<{ name: string; body: string; status: string; sek: string | null }> = [
    {
      name: "documented order",
      body: `[{"SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      status: "ok",
      sek: "0.30722",
    },
    {
      name: "reordered body",
      body: `[{"time_end":"${W10.end}","EXR":11.17,"time_start":"${W10.start}","EUR_per_kWh":0.027,"SEK_per_kWh":0.30722}]`,
      status: "ok",
      sek: "0.30722",
    },
    {
      name: "quoted price",
      body: `[{"SEK_per_kWh":"0.30722","EUR_per_kWh":0.027,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      status: "ok",
      sek: "0.30722",
    },
    {
      name: "scientific price, unquoted",
      body: `[{"SEK_per_kWh":1e-05,"EUR_per_kWh":1e-06,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      status: "ok",
      sek: "1e-05",
    },
    {
      name: "integer price",
      body: `[{"SEK_per_kWh":1,"EUR_per_kWh":0.09,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      status: "ok",
      sek: "1",
    },
    { name: "body that is not JSON", body: "<html>rate limited</html>", status: "malformed", sek: null },
    { name: "JSON of the wrong shape, object", body: '{"prices":[]}', status: "malformed", sek: null },
    {
      name: "JSON of the wrong shape, other keys",
      body: `[{"price_sek":0.30722,"from":"${W10.start}","to":"${W10.end}"}]`,
      status: "malformed",
      sek: null,
    },
    { name: "empty array", body: "[]", status: "missing_window", sek: null },
    {
      name: "valid day, no window for this hour",
      body: `[{"SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17,"time_start":"2026-09-20T00:00:00+02:00","time_end":"2026-09-20T00:15:00+02:00"}]`,
      status: "missing_window",
      sek: null,
    },
  ];
  for (const row of rows) {
    const feed = new EnergySpotFeed(async () => new Response(row.body, { status: 200 }));
    const read = await feed.readWindow(AT_10_05);
    assert.equal(read.status, row.status, row.name);
    assert.equal(read.window?.sekPerKwh ?? null, row.sek, row.name);
    if (row.sek !== null) {
      assert.equal(read.window?.timeStart, W10.start, row.name);
    }
  }
  const seen = new Set(rows.map((r) => r.status));
  assert.deepEqual([...seen].sort(), ["malformed", "missing_window", "ok"]);
});

test("a skipped or nested entry cannot hand its price to a neighbouring window", () => {
  const rows: Array<{ name: string; body: string; expect: Array<{ start: string; sek: string }> }> = [
    {
      name: "entry without time_end before the real window",
      body: `[{"SEK_per_kWh":0.5,"time_start":"2026-09-20T09:45:00+02:00","time_end":null},{"SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      expect: [{ start: W10.start, sek: "0.30722" }],
    },
    {
      name: "entry with a null price before the real window",
      body: `[{"SEK_per_kWh":null,"time_start":"2026-09-20T09:45:00+02:00","time_end":"${W10.start}"},{"SEK_per_kWh":0.30722,"time_start":"${W10.start}","time_end":"${W10.end}"}]`,
      expect: [{ start: W10.start, sek: "0.30722" }],
    },
    {
      name: "entry repeating the key in a nested object",
      body: `[{"SEK_per_kWh":0.30722,"meta":{"SEK_per_kWh":9.9},"time_start":"${W10.start}","time_end":"${W10.end}"},{"SEK_per_kWh":0.4,"time_start":"${W10.end}","time_end":"2026-09-20T10:30:00+02:00"}]`,
      expect: [
        { start: W10.start, sek: "0.30722" },
        { start: W10.end, sek: "0.4" },
      ],
    },
  ];
  for (const row of rows) {
    const got = parseFeedBody(row.body).map((w) => ({ start: w.timeStart, sek: w.sekPerKwh }));
    assert.deepEqual(got, row.expect, row.name);
  }
});
