import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { PURPOSE_MAX_LEN } from './constants';
import { parseRuleRequest } from './ruleRequest';

// sdk/src/fixtures/rule-request-v1.json is the shared corpus when it is on main.
// Until that file is in the tree, the cases below are pinned here.

type FixtureCase = {
  name: string;
  input: string;
  ok: boolean;
  agent?: string;
  payee?: string;
  mint?: string;
  cap?: string;
  max?: string;
  days?: number;
  purpose?: string;
  agentLabel?: string | null;
  payeeLabel?: string | null;
};

function key(): string {
  return Keypair.generate().publicKey.toBase58();
}

function url(fields: Record<string, string>, extra = ''): string {
  const query = Object.entries(fields)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
  return `veto://rule-request?${query}${extra}`;
}

function base(): Record<string, string> {
  return {
    v: '1',
    agent: key(),
    payee: key(),
    mint: key(),
    cap: '5000000',
    max: '500000',
    days: '30',
    purpose: 'charge the car',
  };
}

function pinnedCases(): FixtureCase[] {
  const full = base();
  const withLabels: Record<string, string> = {
    ...base(),
    purpose: 'café + night',
    agentLabel: 'Cafe bot',
    payeeLabel: 'North charger',
  };
  const edge = { ...base(), days: '1', cap: '9', max: '9', purpose: 'p'.repeat(PURPOSE_MAX_LEN) };
  const high = { ...base(), days: '3650' };
  const cases: FixtureCase[] = [
    {
      name: 'valid request with labels and an unknown key',
      input: `${url(withLabels)}&note=ignore-me`,
      ok: true,
      agent: withLabels.agent,
      payee: withLabels.payee,
      mint: withLabels.mint,
      cap: withLabels.cap,
      max: withLabels.max,
      days: 30,
      purpose: 'café + night',
      agentLabel: 'Cafe bot',
      payeeLabel: 'North charger',
    },
    {
      name: 'days 1, equal max and cap, purpose at the program limit',
      input: url(edge),
      ok: true,
      cap: '9',
      max: '9',
      days: 1,
      purpose: 'p'.repeat(PURPOSE_MAX_LEN),
    },
    { name: 'days 3650', input: url(high), ok: true, days: 3650 },
  ];
  for (const name of ['v', 'agent', 'payee', 'mint', 'cap', 'max', 'days', 'purpose'] as const) {
    const fields = base();
    delete fields[name];
    cases.push({ name: `missing ${name}`, input: url(fields), ok: false });
  }
  const spaced = base();
  spaced.payee = `${spaced.payee} `;
  cases.push({ name: 'non-canonical payee', input: url(spaced), ok: false });
  cases.push({ name: 'zero cap', input: url({ ...base(), cap: '0', max: '0' }), ok: false });
  cases.push({ name: 'zero largest payment', input: url({ ...base(), max: '0' }), ok: false });
  cases.push({ name: 'largest payment above the cap', input: url({ ...base(), cap: '10', max: '11' }), ok: false });
  cases.push({
    name: 'purpose longer than the program allows',
    input: url({ ...base(), purpose: 'p'.repeat(PURPOSE_MAX_LEN + 1) }),
    ok: false,
  });
  for (const days of ['0', '3651', '07']) {
    cases.push({ name: `days ${days}`, input: url({ ...base(), days }), ok: false });
  }
  cases.push({ name: 'version 2', input: url({ ...base(), v: '2' }), ok: false });
  cases.push({ name: 'repeated cap', input: `${url(full)}&cap=1`, ok: false });
  return cases;
}

function loadFixture(text: string): FixtureCase[] {
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown }).cases)
      ? (parsed as { cases: unknown[] }).cases
      : null;
  if (!rows) {
    throw new Error('rule-request-v1 fixture has no cases');
  }
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new Error(`fixture case ${index} is not an object`);
    }
    const rec = row as Record<string, unknown>;
    const input = rec.input ?? rec.url ?? rec.link;
    if (typeof input !== 'string') {
      throw new Error(`fixture case ${index} has no input`);
    }
    const expect =
      rec.expect && typeof rec.expect === 'object' ? (rec.expect as Record<string, unknown>) : rec;
    const ok = rec.ok === true || rec.valid === true;
    const invalid = rec.ok === false || rec.valid === false;
    if (!ok && !invalid) {
      throw new Error(`fixture case ${index} does not say whether it is valid`);
    }
    return {
      name: typeof rec.name === 'string' ? rec.name : `case ${index}`,
      input,
      ok,
      agent: typeof expect.agent === 'string' ? expect.agent : undefined,
      payee: typeof expect.payee === 'string' ? expect.payee : undefined,
      mint: typeof expect.mint === 'string' ? expect.mint : undefined,
      cap: expect.cap == null ? undefined : String(expect.cap),
      max: expect.max == null ? undefined : String(expect.max),
      days: typeof expect.days === 'number' ? expect.days : undefined,
      purpose: typeof expect.purpose === 'string' ? expect.purpose : undefined,
      agentLabel: typeof expect.agentLabel === 'string' ? expect.agentLabel : undefined,
      payeeLabel: typeof expect.payeeLabel === 'string' ? expect.payeeLabel : undefined,
    };
  });
}

test('rule request v1 cases run through the app parser', () => {
  const fixturePath = fileURLToPath(new URL('../../sdk/src/fixtures/rule-request-v1.json', import.meta.url));
  const fixtureOnTree = existsSync(fixturePath);
  const cases = fixtureOnTree ? loadFixture(readFileSync(fixturePath, 'utf8')) : pinnedCases();
  assert.ok(cases.length >= 8, fixtureOnTree ? fixturePath : 'pinned cases, fixture not on this tree');
  for (const item of cases) {
    const parsed = parseRuleRequest(item.input);
    assert.equal(parsed.ok, item.ok, item.name);
    if (!item.ok) {
      assert.equal('request' in parsed, false, item.name);
      continue;
    }
    if (!parsed.ok) {
      continue;
    }
    if (item.agent) {
      assert.equal(parsed.request.agent, item.agent, item.name);
    }
    if (item.payee) {
      assert.equal(parsed.request.payee, item.payee, item.name);
    }
    if (item.mint) {
      assert.equal(parsed.request.mint, item.mint, item.name);
    }
    if (item.cap) {
      assert.equal(parsed.request.cap, BigInt(item.cap), item.name);
    }
    if (item.max) {
      assert.equal(parsed.request.max, BigInt(item.max), item.name);
    }
    if (item.days != null) {
      assert.equal(parsed.request.days, item.days, item.name);
    }
    if (item.purpose) {
      assert.equal(parsed.request.purpose, item.purpose, item.name);
    }
    if (item.agentLabel) {
      assert.equal(parsed.request.agentLabel, item.agentLabel, item.name);
    }
    if (item.payeeLabel) {
      assert.equal(parsed.request.payeeLabel, item.payeeLabel, item.name);
    }
  }
});
