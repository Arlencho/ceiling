import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { parseAdvisoryMemo as parseAppAdvisoryMemo } from './advisory';
import { parseAdvisoryMemo as parseSdkAdvisoryMemo } from '../../sdk/src/advisory';

const PREFIX = 'veto-advisory:v1';
const MANDATE = '11111111111111111111111111111111';
const OTHER = '11111111111111111111111111111112';
const HASH = '1bfe4ca8d9b4656be983772e79f79eb552b24fd03ca715f2dfab3baa347692de';
const U64_MAX = '18446744073709551615';
const OVER_U64 = '18446744073709551616';

type Parsed = {
  mandate: string;
  amount: bigint;
  nonce: bigint;
  reason: string;
  descriptionSha256: string;
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function memo(fields: {
  mandate?: string;
  amount?: string;
  nonce?: string;
  reason?: string;
  description_sha256?: string;
  extra?: boolean;
}): string {
  const record: Record<string, unknown> = {
    mandate: fields.mandate ?? MANDATE,
    amount: fields.amount ?? '180',
    nonce: fields.nonce ?? '7',
    reason: fields.reason ?? 'bar tab, not transport',
    description_sha256: fields.description_sha256 ?? HASH,
  };
  if (fields.extra !== undefined) {
    record.extra = fields.extra;
  }
  return `${PREFIX}${JSON.stringify(record)}`;
}

function parsed(fields: {
  mandate?: string;
  amount?: bigint;
  nonce?: bigint;
  reason?: string;
  descriptionSha256?: string;
}): Parsed {
  return {
    mandate: fields.mandate ?? MANDATE,
    amount: fields.amount ?? 180n,
    nonce: fields.nonce ?? 7n,
    reason: fields.reason ?? 'bar tab, not transport',
    descriptionSha256: fields.descriptionSha256 ?? HASH,
  };
}

const EXACT =
  'veto-advisory:v1{"mandate":"11111111111111111111111111111111","amount":"180","nonce":"7","reason":"bar tab, not transport","description_sha256":"1bfe4ca8d9b4656be983772e79f79eb552b24fd03ca715f2dfab3baa347692de"}';

const ESCAPED_REASON = 'say "no" \\ now\nstop';
const CAPPED_REASON = 'a'.repeat(255);
const LONG_REASON = 'a'.repeat(300);
const OVERFLOW_HASH = sha256('overflow');

const fixtures: { name: string; text: string; expected: Parsed | null }[] = [
  {
    name: 'a compact v1 memo with the five keys',
    text: EXACT,
    expected: parsed({}),
  },
  {
    name: 'a declined reason that contains quotes, a backslash, and a newline',
    text: memo({ amount: '500', nonce: '4', reason: ESCAPED_REASON }),
    expected: parsed({ amount: 500n, nonce: 4n, reason: ESCAPED_REASON }),
  },
  {
    name: 'the 255-byte reason stored when a longer reason is cut on a character boundary',
    text: memo({
      amount: '1',
      nonce: '1',
      reason: CAPPED_REASON,
      description_sha256: OVERFLOW_HASH,
    }),
    expected: parsed({
      amount: 1n,
      nonce: 1n,
      reason: CAPPED_REASON,
      descriptionSha256: OVERFLOW_HASH,
    }),
  },
  {
    name: 'a reason longer than 256 bytes, which the parser keeps',
    text: memo({ reason: LONG_REASON }),
    expected: parsed({ reason: LONG_REASON }),
  },
  {
    name: 'the agent-signed memo counted for that mandate',
    text: memo({ amount: '500', nonce: '9', reason: 'not the stated purpose' }),
    expected: parsed({ amount: 500n, nonce: 9n, reason: 'not the stated purpose' }),
  },
  {
    name: 'the memo text a stranger can carry, which still parses',
    text: memo({
      amount: '1',
      nonce: '2',
      reason: 'nope',
      description_sha256: 'ab'.repeat(32),
    }),
    expected: parsed({
      amount: 1n,
      nonce: 2n,
      reason: 'nope',
      descriptionSha256: 'ab'.repeat(32),
    }),
  },
  {
    name: 'the kept memo beside the malformed ones',
    text: memo({
      amount: '7',
      nonce: '3',
      reason: 'kept',
      description_sha256: 'cd'.repeat(32),
    }),
    expected: parsed({
      amount: 7n,
      nonce: 3n,
      reason: 'kept',
      descriptionSha256: 'cd'.repeat(32),
    }),
  },
  {
    name: 'a memo that names a different canonical mandate',
    text: memo({ mandate: OTHER, amount: '7', nonce: '3', reason: 'x', description_sha256: 'cd'.repeat(32) }),
    expected: parsed({
      mandate: OTHER,
      amount: 7n,
      nonce: 3n,
      reason: 'x',
      descriptionSha256: 'cd'.repeat(32),
    }),
  },
  {
    name: 'an empty reason',
    text: memo({ reason: '' }),
    expected: parsed({ reason: '' }),
  },
  {
    name: 'a reason that contains an emoji',
    text: memo({ reason: 'no 😀' }),
    expected: parsed({ reason: 'no 😀' }),
  },
  {
    name: 'the five keys in a different order',
    text: `${PREFIX}{"reason":"bar tab, not transport","description_sha256":"${HASH}","nonce":"7","amount":"180","mandate":"${MANDATE}"}`,
    expected: parsed({}),
  },
  {
    name: 'a space between the prefix and the json object',
    text: `${PREFIX} {"mandate":"${MANDATE}","amount":"180","nonce":"7","reason":"bar tab, not transport","description_sha256":"${HASH}"}`,
    expected: parsed({}),
  },
  {
    name: 'a zero amount and a zero nonce',
    text: memo({ amount: '0', nonce: '0' }),
    expected: parsed({ amount: 0n, nonce: 0n }),
  },
  {
    name: 'the largest u64 amount and nonce',
    text: memo({ amount: U64_MAX, nonce: U64_MAX }),
    expected: parsed({ amount: BigInt(U64_MAX), nonce: BigInt(U64_MAX) }),
  },
  {
    name: 'malformed json',
    text: `${PREFIX}{`,
    expected: null,
  },
  {
    name: 'a truncated json object',
    text: `${PREFIX}{"mandate":`,
    expected: null,
  },
  {
    name: 'the prefix with no json after it',
    text: PREFIX,
    expected: null,
  },
  {
    name: 'json null',
    text: `${PREFIX}null`,
    expected: null,
  },
  {
    name: 'a json array',
    text: `${PREFIX}[]`,
    expected: null,
  },
  {
    name: 'an extra key',
    text: memo({ extra: true, amount: '7', nonce: '3', reason: 'x', description_sha256: 'cd'.repeat(32) }),
    expected: null,
  },
  {
    name: 'a renamed description hash key',
    text: EXACT.replace('description_sha256', 'descriptionHash'),
    expected: null,
  },
  {
    name: 'a non-canonical mandate key',
    text: memo({ mandate: `1${MANDATE}` }),
    expected: null,
  },
  {
    name: 'an over-u64 amount',
    text: memo({ amount: OVER_U64 }),
    expected: null,
  },
  {
    name: 'an over-u64 nonce',
    text: memo({ nonce: OVER_U64 }),
    expected: null,
  },
  {
    name: 'an amount with a leading zero',
    text: memo({ amount: '01' }),
    expected: null,
  },
  {
    name: 'a negative amount',
    text: memo({ amount: '-1' }),
    expected: null,
  },
  {
    name: 'a decimal amount',
    text: memo({ amount: '1.5' }),
    expected: null,
  },
  {
    name: 'an amount written as a json number',
    text: EXACT.replace('"180"', '180'),
    expected: null,
  },
  {
    name: 'an uppercase description hash',
    text: memo({
      amount: '7',
      nonce: '3',
      reason: 'x',
      description_sha256: 'cd'.repeat(32).toUpperCase(),
    }),
    expected: null,
  },
  {
    name: 'a description hash shorter than 64 hex characters',
    text: memo({ description_sha256: HASH.slice(0, 63) }),
    expected: null,
  },
  {
    name: 'a wrong prefix',
    text: EXACT.replace(PREFIX, 'veto-advisory:v2'),
    expected: null,
  },
];

for (const fixture of fixtures) {
  test(`the app parser and the sdk parser agree on ${fixture.name}`, () => {
    const fromApp = parseAppAdvisoryMemo(fixture.text);
    const fromSdk = parseSdkAdvisoryMemo(fixture.text);
    assert.deepEqual(fromApp, fixture.expected);
    assert.deepEqual(fromSdk, fixture.expected);
  });
}

test('the app advisory module parses memos without the sdk', () => {
  const source = readFileSync(new URL('./advisory.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('sdk/src'), false);
  assert.equal(source.includes('node:crypto'), false);
  assert.equal(source.includes('node-crypto'), false);
});

test('metro resolves the app without the sdk or a crypto shim', () => {
  const metro = readFileSync(new URL('../metro.config.js', import.meta.url), 'utf8');
  assert.equal(metro.includes('../sdk'), false);
  assert.equal(metro.includes('node-crypto'), false);
  assert.equal(metro.includes('watchFolders'), false);
  assert.equal(metro.includes('nodeModulesPaths'), false);
});

test('the app tsconfig does not add node types', () => {
  const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8')) as {
    compilerOptions: { types?: unknown };
  };
  assert.equal(tsconfig.compilerOptions.types, undefined);
});

test('the node crypto shim is not part of the app', () => {
  assert.equal(existsSync(new URL('../shims/node-crypto.js', import.meta.url)), false);
});
