import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import {
  LABEL_MAX_CHARS,
  PURPOSE_MAX_BYTES,
  RULE_REQUEST_CHECK_ORDER,
  RULE_REQUEST_DAYS_MAX,
  RULE_REQUEST_DAYS_MIN,
  RuleRequestRejected,
  createRuleRequest,
  parseRuleRequest,
} from "./index.js";
import type { RuleRequest, RuleRequestInput } from "./index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rule-request-v1.json", import.meta.url));

type Expectation = {
  v: 1;
  agent: string;
  payee: string;
  mint: string;
  cap: string;
  max: string;
  days: number;
  purpose: string;
  agentLabel?: string;
  payeeLabel?: string;
};

type ValidFixture = {
  name: string;
  input?: RuleRequestInput;
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
  input: RuleRequestInput;
  problem: string;
  message: string;
};

type FixtureFile = {
  purposeMaxBytes: number;
  labelMaxChars: number;
  daysMin: number;
  daysMax: number;
  u64Max: string;
  checkOrder: string[];
  valid: ValidFixture[];
  invalid: InvalidFixture[];
  rejectedInputs: RejectedFixture[];
};

const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;

const DOCUMENTED_URL =
  "veto://rule-request?v=1&agent=AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9&payee=9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu&mint=GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse&cap=1000&max=100&days=30&purpose=API%20fees";

function serialized(request: RuleRequest): Expectation {
  const out: Expectation = {
    v: request.v,
    agent: request.agent,
    payee: request.payee,
    mint: request.mint,
    cap: request.cap.toString(10),
    max: request.max.toString(10),
    days: request.days,
    purpose: request.purpose,
  };
  if (request.agentLabel !== undefined) out.agentLabel = request.agentLabel;
  if (request.payeeLabel !== undefined) out.payeeLabel = request.payeeLabel;
  return out;
}

function inputFrom(expect: Expectation): RuleRequestInput {
  return {
    agent: expect.agent,
    payee: expect.payee,
    mint: expect.mint,
    cap: expect.cap,
    max: expect.max,
    days: expect.days,
    purpose: expect.purpose,
    ...(expect.agentLabel !== undefined ? { agentLabel: expect.agentLabel } : {}),
    ...(expect.payeeLabel !== undefined ? { payeeLabel: expect.payeeLabel } : {}),
  };
}

test("the purpose byte cap is the program constant", () => {
  const state = readFileSync(fileURLToPath(new URL("../../programs/veto/src/state.rs", import.meta.url)), "utf8");
  const lib = readFileSync(fileURLToPath(new URL("../../programs/veto/src/lib.rs", import.meta.url)), "utf8");
  const match = state.match(/pub const PURPOSE_MAX_LEN:\s*usize\s*=\s*(\d+)\s*;/);
  assert.ok(match);
  assert.equal(PURPOSE_MAX_BYTES, Number(match[1]));
  assert.match(state, /#\[max_len\(PURPOSE_MAX_LEN\)\]/);
  assert.match(lib, /args\.purpose\.chars\(\)\.count\(\)\s*<=\s*PURPOSE_MAX_LEN/);
  assert.equal(fixtures.purposeMaxBytes, PURPOSE_MAX_BYTES);
  assert.equal(fixtures.labelMaxChars, LABEL_MAX_CHARS);
  assert.equal(fixtures.daysMin, RULE_REQUEST_DAYS_MIN);
  assert.equal(fixtures.daysMax, RULE_REQUEST_DAYS_MAX);
  assert.equal(fixtures.u64Max, ((1n << 64n) - 1n).toString(10));
  assert.deepEqual(fixtures.checkOrder, [...RULE_REQUEST_CHECK_ORDER]);
});

test("every problem in the check order has an invalid fixture", () => {
  const seen = new Set(fixtures.invalid.map((item) => item.problem));
  for (const problem of RULE_REQUEST_CHECK_ORDER) {
    assert.ok(seen.has(problem), problem);
  }
});

test("createRuleRequest prints the documented URL", () => {
  const url = createRuleRequest({
    agent: "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9",
    payee: "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu",
    mint: "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse",
    cap: 1000n,
    max: 100n,
    days: 30,
    purpose: "API fees",
  });
  assert.equal(url, DOCUMENTED_URL);
  const documented = fixtures.valid.find((item) => item.name === "prints the documented URL for API fees");
  assert.ok(documented);
  assert.equal(documented.url, DOCUMENTED_URL);
});

test("createRuleRequest accepts a bigint cap at the u64 maximum", () => {
  const parsed = parseRuleRequest(
    createRuleRequest({
      agent: "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9",
      payee: "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu",
      mint: "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse",
      cap: 18446744073709551615n,
      max: 1n,
      days: 3650n,
      purpose: "ceiling",
    }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.cap, 18446744073709551615n);
  assert.equal(parsed.request.max, 1n);
  assert.equal(parsed.request.days, 3650);
});

test("a value that is not a string is not a rule request URL", () => {
  assert.deepEqual(parseRuleRequest(undefined as unknown as string), {
    ok: false,
    error: { problem: "not_a_url", message: "the request is not a URL" },
  });
});

for (const fixture of fixtures.valid) {
  test(fixture.name, () => {
    if (fixture.input) {
      assert.equal(createRuleRequest(fixture.input), fixture.url);
    }
    const parsed = parseRuleRequest(fixture.url);
    assert.equal(parsed.ok, true, parsed.ok ? "" : `${parsed.error.problem}: ${parsed.error.message}`);
    if (!parsed.ok) return;
    assert.deepEqual(serialized(parsed.request), fixture.expect);
    assert.equal(createRuleRequest(inputFrom(fixture.expect)), fixture.canonical ?? fixture.url);
  });
}

for (const fixture of fixtures.invalid) {
  test(fixture.name, () => {
    const parsed = parseRuleRequest(fixture.url);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.deepEqual(parsed.error, { problem: fixture.problem, message: fixture.message });
  });
}

for (const fixture of fixtures.rejectedInputs) {
  test(fixture.name, () => {
    assert.throws(
      () => createRuleRequest(fixture.input),
      (caught: unknown) => {
        assert.ok(caught instanceof RuleRequestRejected);
        assert.equal(caught.problem, fixture.problem);
        assert.equal(caught.message, fixture.message);
        return true;
      },
    );
  });
}

test("percent-encoding round-trips every Unicode scalar value that fits in a purpose", () => {
  const agent = "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
  const payee = "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu";
  const mint = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse";
  let buf = "";
  let bytes = 0;
  const flush = (): void => {
    if (buf === "") return;
    const url = createRuleRequest({ agent, payee, mint, cap: 1n, max: 1n, days: 1, purpose: buf });
    assert.equal(url.endsWith(`purpose=${encodeURIComponent(buf)}`), true);
    const parsed = parseRuleRequest(url);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.request.purpose, buf);
    buf = "";
    bytes = 0;
  };
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    const size = Buffer.byteLength(character);
    if (bytes + size > PURPOSE_MAX_BYTES) flush();
    buf += character;
    bytes += size;
  }
  flush();
});

test("the example prints a request URL for an agent key and limits", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-request-"));
  try {
    const kp = Keypair.generate();
    const keyPath = join(dir, "agent.json");
    writeFileSync(keyPath, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const example = fileURLToPath(new URL("../examples/rule-request.ts", import.meta.url));
    const result = spawnSync(
      tsx,
      [
        example,
        keyPath,
        "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu",
        "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse",
        "1000",
        "250",
        "14",
        "API fees",
        "billing",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = parseRuleRequest(result.stdout.trim());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.request.agent, kp.publicKey.toBase58());
    assert.equal(parsed.request.payee, "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu");
    assert.equal(parsed.request.mint, "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse");
    assert.equal(parsed.request.cap, 1000n);
    assert.equal(parsed.request.max, 250n);
    assert.equal(parsed.request.days, 14);
    assert.equal(parsed.request.purpose, "API fees");
    assert.equal(parsed.request.agentLabel, "billing");
    assert.equal(parsed.request.payeeLabel, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the example names a purpose that is too long and exits", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-request-"));
  try {
    const kp = Keypair.generate();
    const keyPath = join(dir, "agent.json");
    writeFileSync(keyPath, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const example = fileURLToPath(new URL("../examples/rule-request.ts", import.meta.url));
    const result = spawnSync(
      tsx,
      [
        example,
        keyPath,
        "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu",
        "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse",
        "1",
        "1",
        "1",
        "a".repeat(65),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /purpose is longer than 64 bytes/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
