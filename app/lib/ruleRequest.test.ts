import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';

import { PURPOSE_MAX_LEN } from './constants';
import { parseRuleRequest, ruleRequestHref } from './ruleRequest';

function key(): string {
  return Keypair.generate().publicKey.toBase58();
}

function requestUrl(overrides: Record<string, string | null> = {}, extra = ''): string {
  const agent = key();
  const payee = key();
  const mint = key();
  const fields: Record<string, string> = {
    v: '1',
    agent,
    payee,
    mint,
    cap: '5000000',
    max: '500000',
    days: '30',
    purpose: 'charge the car',
    ...Object.fromEntries(Object.entries(overrides).filter((entry): entry is [string, string] => entry[1] != null)),
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value == null) {
      delete fields[name];
    }
  }
  const query = Object.entries(fields)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
  return `veto://rule-request?${query}${extra}`;
}

test('a complete v1 request keeps every field and ignores an unknown key', () => {
  const agent = key();
  const payee = key();
  const mint = key();
  const url = `veto://rule-request?v=1&agent=${agent}&payee=${payee}&mint=${mint}&cap=5000000&max=500000&days=30&purpose=${encodeURIComponent('charge the car')}&note=ignore-me&agentLabel=${encodeURIComponent('Cafe bot')}&payeeLabel=${encodeURIComponent('North charger')}`;
  const parsed = parseRuleRequest(url);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.request.agent, agent);
  assert.equal(parsed.request.payee, payee);
  assert.equal(parsed.request.mint, mint);
  assert.equal(parsed.request.cap, 5000000n);
  assert.equal(parsed.request.max, 500000n);
  assert.equal(parsed.request.days, 30);
  assert.equal(parsed.request.purpose, 'charge the car');
  assert.equal(parsed.request.agentLabel, 'Cafe bot');
  assert.equal(parsed.request.payeeLabel, 'North charger');
  assert.equal('note' in parsed.request, false);
});

test('a purpose is percent-encoded UTF-8 and a plus sign stays a plus', () => {
  const url = requestUrl({ purpose: 'café + night' });
  const parsed = parseRuleRequest(url);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.request.purpose, 'café + night');
  }
});

test('days may be 1 or 3650 and the largest payment may equal the cap', () => {
  const low = parseRuleRequest(requestUrl({ days: '1', cap: '9', max: '9' }));
  const high = parseRuleRequest(requestUrl({ days: '3650' }));
  assert.equal(low.ok, true);
  assert.equal(high.ok, true);
  if (low.ok) {
    assert.equal(low.request.days, 1);
    assert.equal(low.request.max, low.request.cap);
  }
});

test('a missing required key is invalid and returns no request fields', () => {
  for (const name of ['v', 'agent', 'payee', 'mint', 'cap', 'max', 'days', 'purpose']) {
    const parsed = parseRuleRequest(requestUrl({ [name]: null }));
    assert.equal(parsed.ok, false, name);
    assert.equal('request' in parsed, false, name);
    if (!parsed.ok) {
      assert.match(parsed.reason, new RegExp(name));
    }
  }
});

test('a non-canonical address is rejected and the other fields are not returned', () => {
  const parsed = parseRuleRequest(requestUrl({ payee: `${key()} ` }));
  assert.equal(parsed.ok, false);
  assert.equal('request' in parsed, false);
  if (!parsed.ok) {
    assert.match(parsed.reason, /payee/);
    assert.match(parsed.reason, /canonical/);
  }
  const bad = parseRuleRequest(requestUrl({ agent: 'not-an-address' }));
  assert.equal(bad.ok, false);
  assert.equal('request' in bad, false);
});

test('a zero amount, a largest payment above the cap, or a purpose past the program limit is invalid', () => {
  const zeroCap = parseRuleRequest(requestUrl({ cap: '0', max: '0' }));
  const zeroMax = parseRuleRequest(requestUrl({ max: '0' }));
  const over = parseRuleRequest(requestUrl({ cap: '10', max: '11' }));
  const longPurpose = parseRuleRequest(requestUrl({ purpose: 'p'.repeat(PURPOSE_MAX_LEN + 1) }));
  assert.equal(zeroCap.ok, false);
  assert.equal(zeroMax.ok, false);
  assert.equal(over.ok, false);
  assert.equal(longPurpose.ok, false);
  if (!zeroCap.ok) {
    assert.match(zeroCap.reason, /zero/);
  }
  if (!over.ok) {
    assert.match(over.reason, /above the cap/);
  }
  if (!longPurpose.ok) {
    assert.match(longPurpose.reason, /longer/);
  }
  const exact = parseRuleRequest(requestUrl({ purpose: 'p'.repeat(PURPOSE_MAX_LEN) }));
  assert.equal(exact.ok, true);
});

test('a duration outside 1 to 3650 days is invalid', () => {
  for (const days of ['0', '3651', '1.5', '07', '-1']) {
    const parsed = parseRuleRequest(requestUrl({ days }));
    assert.equal(parsed.ok, false, days);
    assert.equal('request' in parsed, false);
  }
});

test('version 2 and a repeated cap are invalid', () => {
  const version = parseRuleRequest(requestUrl({ v: '2' }));
  assert.equal(version.ok, false);
  const repeated = parseRuleRequest(`${requestUrl()}&cap=1`);
  assert.equal(repeated.ok, false);
  assert.equal('request' in repeated, false);
});

test('a rule request link opens the approval route and another link does not', () => {
  const url = requestUrl();
  const href = ruleRequestHref(url);
  assert.ok(href);
  assert.equal(href?.startsWith('/rule-request?url='), true);
  const recovered = decodeURIComponent(href!.slice(href!.indexOf('url=') + 4));
  const parsed = parseRuleRequest(recovered);
  assert.equal(parsed.ok, true);
  assert.equal(ruleRequestHref('veto://rules'), null);
  assert.equal(ruleRequestHref('https://example.com/rule-request?v=1'), null);
});

test('the default public key is canonical and still parses', () => {
  const parsed = parseRuleRequest(requestUrl({ payee: PublicKey.default.toBase58() }));
  assert.equal(parsed.ok, true);
});

test('cold start reads the initial link and a warm link listens for the next one', () => {
  const src = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(src, /getInitialURL/);
  assert.match(src, /addEventListener\(\s*'url'/);
  assert.match(src, /ruleRequestHref/);
});
