import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TRADE_REQUEST_CHECK_ORDER,
  TradeRuleRequestRejected,
  createTradeRuleRequest,
  parseRuleRequest,
  parseTradeRuleRequest,
} from "./rule-request.js";
import type { TradeRuleRequest, TradeRuleRequestInput } from "./rule-request.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rule-request-v2.json", import.meta.url));

type Expectation = {
  v: 2;
  kind: "trade";
  agent: string;
  inMint: string;
  outMint: string;
  pool: string;
  perTrade: string;
  daily: string;
  cap: string;
  floorBps: string;
  days: number;
  purpose: string;
  agentLabel?: string;
  poolLabel?: string;
};

type ValidFixture = {
  name: string;
  input?: TradeRuleRequestInput;
  url: string;
  canonical?: string;
  expect: Expectation;
};

type InvalidFixture = {
  name: string;
  url: string;
  problem: string;
  message: string;
};

type RejectedFixture = {
  name: string;
  input: TradeRuleRequestInput;
  problem: string;
  message: string;
};

type FixtureFile = {
  checkOrder: string[];
  valid: ValidFixture[];
  invalid: InvalidFixture[];
  rejectedInputs: RejectedFixture[];
};

const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;

function serialized(request: TradeRuleRequest): Expectation {
  return {
    v: request.v,
    kind: request.kind,
    agent: request.agent,
    inMint: request.inMint,
    outMint: request.outMint,
    pool: request.pool,
    perTrade: request.perTrade.toString(10),
    daily: request.daily.toString(10),
    cap: request.cap.toString(10),
    floorBps: request.floorBps.toString(10),
    days: request.days,
    purpose: request.purpose,
    ...(request.agentLabel !== undefined ? { agentLabel: request.agentLabel } : {}),
    ...(request.poolLabel !== undefined ? { poolLabel: request.poolLabel } : {}),
  };
}

function inputFrom(expect: Expectation): TradeRuleRequestInput {
  return {
    agent: expect.agent,
    inMint: expect.inMint,
    outMint: expect.outMint,
    pool: expect.pool,
    perTrade: expect.perTrade,
    daily: expect.daily,
    cap: expect.cap,
    floorBps: expect.floorBps,
    days: expect.days,
    purpose: expect.purpose,
    ...(expect.agentLabel !== undefined ? { agentLabel: expect.agentLabel } : {}),
    ...(expect.poolLabel !== undefined ? { poolLabel: expect.poolLabel } : {}),
  };
}

test("the trade request check order matches the fixture", () => {
  assert.deepEqual(fixtures.checkOrder, [...TRADE_REQUEST_CHECK_ORDER]);
});

test("every trade-request problem has an invalid fixture", () => {
  const seen = new Set(fixtures.invalid.map((item) => item.problem));
  for (const problem of TRADE_REQUEST_CHECK_ORDER) {
    assert.ok(seen.has(problem), problem);
  }
});

test("a v1 reader rejects a trade request at version, before any trade field", () => {
  const documented = fixtures.valid.find((item) => item.name === "prints the documented URL for a pinned pool");
  assert.ok(documented);
  const corrupted = `${documented.url}&purpose=%FF`;
  const parsed = parseRuleRequest(corrupted);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.error, { problem: "bad_v", message: "version must be 1" });
});

for (const fixture of fixtures.valid) {
  test(fixture.name, () => {
    if (fixture.input) {
      assert.equal(createTradeRuleRequest(fixture.input), fixture.url);
    }
    const parsed = parseTradeRuleRequest(fixture.url);
    assert.equal(parsed.ok, true, parsed.ok ? "" : `${parsed.error.problem}: ${parsed.error.message}`);
    if (!parsed.ok) return;
    assert.deepEqual(serialized(parsed.request), fixture.expect);
    assert.equal(createTradeRuleRequest(inputFrom(fixture.expect)), fixture.canonical ?? fixture.url);
  });
}

for (const fixture of fixtures.invalid) {
  test(fixture.name, () => {
    const parsed = parseTradeRuleRequest(fixture.url);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.deepEqual(parsed.error, { problem: fixture.problem, message: fixture.message });
  });
}

for (const fixture of fixtures.rejectedInputs) {
  test(fixture.name, () => {
    assert.throws(
      () => createTradeRuleRequest(fixture.input),
      (caught: unknown) => {
        assert.ok(caught instanceof TradeRuleRequestRejected);
        assert.equal(caught.problem, fixture.problem);
        assert.equal(caught.message, fixture.message);
        return true;
      },
    );
  });
}
