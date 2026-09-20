import assert from "node:assert/strict";
import { test } from "node:test";
import { EnergySpotFeed, feedUrlFor, parseFeedBody, windowContaining } from "./feed.js";

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
