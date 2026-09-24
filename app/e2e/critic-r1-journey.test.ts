// Backend critic, round 1, branch test/e2e-devnet-journey.
//
// Static contract on the journey source and its committed run log. Touches no
// cluster. Run with: cd app && npx tsx --test e2e/critic-r1-journey.test.ts
//
// Each case names the finding it holds open. Green means the finding is closed
// in the source; the devnet run in round 2 is the behavioural check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const journey = readFileSync(new URL('./devnetJourney.test.ts', import.meta.url), 'utf8');
const lastRun = readFileSync(new URL('./last-run.md', import.meta.url), 'utf8');

test('R1 rule A decisions are exported and verified while rule A is still open', () => {
  const exportAt = journey.indexOf("'export.ts'");
  const closeAt = journey.indexOf("'close rule A'");
  assert.ok(exportAt > 0, 'journey never calls export.ts');
  assert.ok(closeAt > 0, 'journey never closes rule A');
  assert.ok(
    exportAt < closeAt,
    'rule A is closed at step 7 and export.ts --signature has no closed-mandate path (tools/lib.ts:509); passing --mandate --nonce --amount fails the same way, so export before close',
  );
});

test('R2 the revoked rule takes one more charge and it is recorded as REASON_NOT_ACTIVE', () => {
  assert.match(
    journey,
    /REASON_NOT_ACTIVE/,
    'docs/VIDEO.md 02:20: the next charge on the revoked rule is refused "mandate not active" and lands on Decisions; the journey pays rule B instead',
  );
});

test('R3 verify output is checked for the lines the video quotes', () => {
  assert.ok(
    journey.includes('Mandate limits, ledger entry, and charge transaction agree.'),
    'docs/VIDEO.md 02:00 quotes this verify.ts line (tools/verify.ts:715); the journey checks only VERDICT: CONFIRMED',
  );
  assert.ok(
    journey.includes('amount (instruction)'),
    'docs/VIDEO.md 02:00 quotes "amount (instruction): record has 1, chain has ..." (tools/verify.ts:555); the journey matches /amount/',
  );
});

test('R4 leftover SOL goes back to the deployer', () => {
  assert.match(
    journey,
    /toPubkey:\s*deployer\.publicKey/,
    'each run funds 0.45 SOL into two keypairs it discards; the deployer went 1.0927 to 0.6412 SOL on one run and the precheck at line 573 refuses below 0.57',
  );
});

test('R5 the committed run log has no failing row', () => {
  assert.ok(!/\|\s*fail\s*\|/.test(lastRun), 'app/e2e/last-run.md ships a red step 8');
});
