// Critic fixture, PR 96 round 1, issue 88: the feed parser's classification
// and price text for every body shape, captured from main at 4233ad3 by
// running main's feed.ts and the branch's side by side (35 bodies, 0 diffs).
// Issue 88 is open: any rewrite of the parser must keep every row here byte
// identical. A row that changes is a block regardless of which looks right.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EnergySpotFeed, isMalformedDayBody, parseFeedBody } from "./feed.js";

const W10 = { start: "2026-09-20T10:00:00+02:00", end: "2026-09-20T10:15:00+02:00" };
const PREV = "2026-09-20T09:45:00+02:00";
const AT = new Date("2026-09-20T10:05:00+02:00");
const OWN = `"SEK_per_kWh":0.30722,"EUR_per_kWh":0.027,"EXR":11.17,"time_start":"${W10.start}","time_end":"${W10.end}"`;
const bodies: Array<[string, string]> = [
  ["documented order", `[{${OWN}}]`],
  ["reordered body", `[{"time_end":"${W10.end}","EXR":11.17,"time_start":"${W10.start}","EUR_per_kWh":0.027,"SEK_per_kWh":0.30722}]`],
  ["quoted price", `[{"SEK_per_kWh":"0.30722","time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["scientific unquoted", `[{"SEK_per_kWh":1e-05,"EUR_per_kWh":1e-06,"time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["scientific quoted", `[{"SEK_per_kWh":"1e-05","time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["scientific uppercase E plus", `[{"SEK_per_kWh":1E+2,"time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["integer", `[{"SEK_per_kWh":1,"time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["negative", `[{"SEK_per_kWh":-0.5,"time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["long mantissa", `[{"SEK_per_kWh":0.123456789012345678901234,"time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["skipped entry, no time_end", `[{"SEK_per_kWh":0.5,"time_start":"${PREV}","time_end":null},{${OWN}}]`],
  ["skipped entry, null price", `[{"SEK_per_kWh":null,"time_start":"${PREV}","time_end":"${W10.start}"},{${OWN}}]`],
  ["skipped entry, bool price", `[{"SEK_per_kWh":true,"time_start":"${PREV}","time_end":"${W10.start}"},{${OWN}}]`],
  ["skipped entry, missing price", `[{"time_start":"${PREV}","time_end":"${W10.start}"},{${OWN}}]`],
  ["nested repeat of the key", `[{"SEK_per_kWh":0.30722,"meta":{"SEK_per_kWh":9.9},"time_start":"${W10.start}","time_end":"${W10.end}"},{"SEK_per_kWh":0.4,"time_start":"${W10.end}","time_end":"2026-09-20T10:30:00+02:00"}]`],
  ["nested key before own key", `[{"meta":{"SEK_per_kWh":9.9},${OWN}}]`],
  ["nested array holding the key", `[{"meta":[{"SEK_per_kWh":9.9}],${OWN}}]`],
  ["key inside a string value", `[{"note":"\\"SEK_per_kWh\\":9.9",${OWN}}]`],
  ["key inside a string with unicode", `[{"note":"caf\\u00e9 \\"SEK_per_kWh\\":0.9",${OWN}}]`],
  ["key written with a unicode escape", `[{"SEK_per_k\\u0057h":0.9,"time_start":"${PREV}","time_end":"${W10.start}"},{${OWN}}]`],
  ["key with whitespace around colon", `[{"SEK_per_kWh" : 0.30722 ,"time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["pretty printed", `[\n  {\n    "SEK_per_kWh": 0.30722,\n    "time_start": "${W10.start}",\n    "time_end": "${W10.end}"\n  }\n]`],
  ["duplicate key, last wins in parse", `[{"SEK_per_kWh":0.1,"SEK_per_kWh":0.30722,"time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["not JSON, html", "<html>rate limited</html>"],
  ["not JSON, truncated", `[{${OWN}`],
  ["not JSON, empty", ""],
  ["wrong shape, object", '{"prices":[]}'],
  ["wrong shape, other keys", `[{"price_sek":0.30722,"from":"${W10.start}","to":"${W10.end}"}]`],
  ["wrong shape, array of numbers", "[1,2,3]"],
  ["wrong shape, array of nulls", "[null]"],
  ["empty array", "[]"],
  ["valid day missing this hour", `[{"SEK_per_kWh":0.30722,"time_start":"2026-09-20T00:00:00+02:00","time_end":"2026-09-20T00:15:00+02:00"}]`],
  ["empty string price", `[{"SEK_per_kWh":"","time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["string price with spaces", `[{"SEK_per_kWh":" 0.30722 ","time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["string price non numeric", `[{"SEK_per_kWh":"abc","time_start":"${W10.start}","time_end":"${W10.end}"}]`],
  ["empty time_start", `[{"SEK_per_kWh":0.30722,"time_start":"","time_end":"${W10.end}"}]`],
];

const expected: Array<{ name: string; status: string; sek: string | null; start: string | null; malformed: boolean; windows: string[] }> = [
  {
    "name": "documented order",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "reordered body",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "quoted price",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "scientific unquoted",
    "status": "ok",
    "sek": "1e-05",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|1e-05"
    ]
  },
  {
    "name": "scientific quoted",
    "status": "ok",
    "sek": "1e-05",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|1e-05"
    ]
  },
  {
    "name": "scientific uppercase E plus",
    "status": "ok",
    "sek": "1E+2",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|1E+2"
    ]
  },
  {
    "name": "integer",
    "status": "ok",
    "sek": "1",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|1"
    ]
  },
  {
    "name": "negative",
    "status": "ok",
    "sek": "-0.5",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|-0.5"
    ]
  },
  {
    "name": "long mantissa",
    "status": "ok",
    "sek": "0.123456789012345678901234",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.123456789012345678901234"
    ]
  },
  {
    "name": "skipped entry, no time_end",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "skipped entry, null price",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "skipped entry, bool price",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "skipped entry, missing price",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "nested repeat of the key",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722",
      "2026-09-20T10:15:00+02:00|2026-09-20T10:30:00+02:00|0.4"
    ]
  },
  {
    "name": "nested key before own key",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "nested array holding the key",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "key inside a string value",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "key inside a string with unicode",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "key written with a unicode escape",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "key with whitespace around colon",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "pretty printed",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "duplicate key, last wins in parse",
    "status": "ok",
    "sek": "0.30722",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "not JSON, html",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "not JSON, truncated",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "not JSON, empty",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "wrong shape, object",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "wrong shape, other keys",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "wrong shape, array of numbers",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "wrong shape, array of nulls",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "empty array",
    "status": "missing_window",
    "sek": null,
    "start": null,
    "malformed": false,
    "windows": []
  },
  {
    "name": "valid day missing this hour",
    "status": "missing_window",
    "sek": null,
    "start": null,
    "malformed": false,
    "windows": [
      "2026-09-20T00:00:00+02:00|2026-09-20T00:15:00+02:00|0.30722"
    ]
  },
  {
    "name": "empty string price",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  },
  {
    "name": "string price with spaces",
    "status": "ok",
    "sek": " 0.30722 ",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00| 0.30722 "
    ]
  },
  {
    "name": "string price non numeric",
    "status": "ok",
    "sek": "abc",
    "start": "2026-09-20T10:00:00+02:00",
    "malformed": false,
    "windows": [
      "2026-09-20T10:00:00+02:00|2026-09-20T10:15:00+02:00|abc"
    ]
  },
  {
    "name": "empty time_start",
    "status": "malformed",
    "sek": null,
    "start": null,
    "malformed": true,
    "windows": []
  }
];

test("critic r1: every feed body classifies and prices exactly as main does", async () => {
  assert.equal(bodies.length, expected.length);
  for (let i = 0; i < bodies.length; i += 1) {
    const [name, body] = bodies[i]!;
    const want = expected[i]!;
    assert.equal(name, want.name);
    const windows = parseFeedBody(body).map((w) => `${w.timeStart}|${w.timeEnd}|${w.sekPerKwh}`);
    const feed = new EnergySpotFeed(async () => new Response(body, { status: 200 }));
    const read = await feed.readWindow(AT);
    assert.deepEqual(
      { name, status: read.status, sek: read.window?.sekPerKwh ?? null, start: read.window?.timeStart ?? null, malformed: isMalformedDayBody(body), windows },
      want,
      name,
    );
  }
});
