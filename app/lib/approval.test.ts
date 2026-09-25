import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
  addressLine,
  agentFieldReady,
  approvalSentence,
  canApprove,
  capFromRing,
  clampTemplate,
  clampToRequest,
  customDateWithin,
  durationChipAllowed,
  formatUntilDate,
  partyDisplay,
  payeeFieldReady,
  templateCapCeiling,
  templateLimits,
  introductionHidesTabBar,
} from './approval';
import { withSavedName } from './addressBook';
import { evaluatePresign, NO_TOKEN_MESSAGE, type PresignObservation } from './presign';
import { BUILD_YOUR_OWN_IDS, templateById } from './templates';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function readyObservation(overrides: Partial<PresignObservation> = {}): PresignObservation {
  return {
    configuredCluster: 'devnet',
    genesisHash: DEVNET_GENESIS,
    ownerTokenBalance: 50n,
    cap: 20n,
    decimals: 6,
    mintReadable: true,
    solLamports: 50_000_000,
    rentAndFeesLamports: 20_000,
    walletFloorLamports: 890_880,
    payeeHasTokenAccount: true,
    ...overrides,
  };
}

test('the sentence names who may pay whom, the largest payment, the cap, and the date', () => {
  assert.equal(
    approvalSentence({
      agent: 'Abcd...wxyz',
      payee: 'Home charger',
      max: '5',
      cap: '50',
      until: '1 October 2026',
    }),
    'Abcd...wxyz may pay Home charger up to 5 per payment and 50 in total, until 1 October 2026',
  );
});

test('the until date is the local calendar day of the expiry', () => {
  const date = new Date(2026, 9, 1, 15, 0, 0);
  const unix = BigInt(Math.floor(date.getTime() / 1000));
  assert.equal(formatUntilDate(unix), '1 October 2026');
});

test('a request can be tightened and cannot be loosened', () => {
  const ceiling = { cap: 100n, max: 10n, expiresAt: 1_000_000n };
  assert.deepEqual(clampToRequest(ceiling, { cap: 250n, max: 40n, expiresAt: 2_000_000n }), ceiling);
  assert.deepEqual(clampToRequest(ceiling, { cap: 40n, max: 4n, expiresAt: 900_000n }), {
    cap: 40n,
    max: 4n,
    expiresAt: 900_000n,
  });
});

test('tightening the cap also pulls the largest payment down to the new cap', () => {
  const next = clampToRequest(
    { cap: 100n, max: 10n, expiresAt: 1_000_000n },
    { cap: 8n, max: 10n, expiresAt: 1_000_000n },
  );
  assert.equal(next.cap, 8n);
  assert.equal(next.max, 8n);
});

test('the ring cannot set a cap above its ceiling', () => {
  assert.equal(capFromRing({ ceiling: 101n, fraction: 0 }), 1n);
  assert.equal(capFromRing({ ceiling: 101n, fraction: 1 }), 101n);
  assert.equal(capFromRing({ ceiling: 101n, fraction: 2 }), 101n);
  assert.equal(capFromRing({ ceiling: 101n, fraction: 0.5 }), 51n);
});

test('a template can raise the cap up to its ceiling and cannot raise the largest payment above the cap', () => {
  const ceiling = templateCapCeiling(100n);
  assert.equal(ceiling > 100n, true);
  const raised = clampTemplate({
    capCeiling: ceiling,
    chosen: { cap: ceiling + 5n, max: ceiling, expiresAt: 10n },
  });
  assert.equal(raised.cap, ceiling);
  assert.equal(raised.max, ceiling);
  const lowered = clampTemplate({
    capCeiling: ceiling,
    chosen: { cap: 12n, max: 40n, expiresAt: 10n },
  });
  assert.equal(lowered.cap, 12n);
  assert.equal(lowered.max, 12n);
});

test('duration chips are 7, 30, and 90, and a request disables any chip past its days', () => {
  assert.equal(durationChipAllowed(7, 30), true);
  assert.equal(durationChipAllowed(30, 30), true);
  assert.equal(durationChipAllowed(90, 30), false);
  assert.equal(durationChipAllowed(90, null), true);
});

test('a custom date cannot land after the request and a template date can', () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const soon = customDateWithin('2026-01-10', nowMs, BigInt(Math.floor(nowMs / 1000) + 30 * 86400));
  const late = customDateWithin('2026-03-01', nowMs, BigInt(Math.floor(nowMs / 1000) + 30 * 86400));
  const open = customDateWithin('2026-03-01', nowMs, null);
  assert.ok(soon);
  assert.equal(late, null);
  assert.ok(open);
});

test('no tokens of the mint says you do not hold this token yet', () => {
  for (const ownerTokenBalance of [0n, null]) {
    const [tokens] = evaluatePresign(readyObservation({ ownerTokenBalance }));
    assert.equal(tokens?.id, 'tokens');
    assert.equal(tokens?.ok, false);
    assert.equal(tokens?.message, NO_TOKEN_MESSAGE);
    assert.match(tokens?.fix ?? '', /wallet/i);
  }
});

test('not enough SOL names the amount and says the rent returns on close', () => {
  const checks = evaluatePresign(
    readyObservation({ solLamports: 10, rentAndFeesLamports: 123456, walletFloorLamports: 1 }),
  );
  const sol = checks.find((check) => check.id === 'sol');
  assert.equal(sol?.ok, false);
  assert.match(sol?.message ?? '', /123456/);
  assert.match(sol?.message ?? '', /returns/);
  assert.match(sol?.message ?? '', /close/);
  assert.match(sol?.fix ?? '', /rent/i);
});

test('the wrong network is a failed check with a plain fix', () => {
  const checks = evaluatePresign(readyObservation({ genesisHash: MAINNET_GENESIS }));
  const network = checks.find((check) => check.id === 'network');
  assert.equal(network?.ok, false);
  assert.match(network?.message ?? '', /Wrong network/);
  assert.match(network?.fix ?? '', /devnet/);
});

test('a payee without a token account is a failed check with a plain fix', () => {
  const checks = evaluatePresign(readyObservation({ payeeHasTokenAccount: false }));
  const payee = checks.find((check) => check.id === 'payee');
  assert.equal(payee?.ok, false);
  assert.match(payee?.message ?? '', /no token account/);
  assert.match(payee?.fix ?? '', /opens a token account/);
});

test('every check passing is the only state that allows approval', () => {
  const ok = evaluatePresign(readyObservation());
  assert.equal(ok.every((check) => check.ok), true);
  const missing = evaluatePresign(readyObservation({ payeeHasTokenAccount: false }));
  assert.equal(missing.every((check) => check.ok), false);
});

test('a request label is a claim beside the short address, and a plain name is only a saved name', () => {
  const address = Keypair.generate().publicKey.toBase58();
  const claimed = partyDisplay({ address, claimedLabel: 'Cafe bot', savedName: null });
  const hidden = addressLine(claimed, false);
  assert.equal(claimed.savedName, null);
  assert.equal(hidden.primary, claimed.shortAddress);
  assert.equal(hidden.beside, 'calls itself Cafe bot');
  assert.notEqual(hidden.primary, 'Cafe bot');
  assert.equal(hidden.full, null);
  const shown = addressLine(claimed, true);
  assert.equal(shown.full, address);
  const saved = addressLine(
    partyDisplay({ address, claimedLabel: 'Cafe bot', savedName: 'Home charger' }),
    false,
  );
  assert.equal(saved.primary, 'Home charger');
  assert.equal(saved.beside, 'calls itself Cafe bot');
});

test('saving a name stores it for that address only', () => {
  const address = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const book = withSavedName({}, address, 'Home charger');
  assert.equal(book[address], 'Home charger');
  assert.equal(book[other], undefined);
  const claimed = partyDisplay({ address, claimedLabel: 'Cafe bot', savedName: book[address] ?? null });
  assert.equal(claimed.savedName, 'Home charger');
  assert.equal(
    partyDisplay({ address: other, claimedLabel: 'Cafe bot', savedName: book[other] ?? null }).savedName,
    null,
  );
});

test('charging and compute templates open with limits already filled in', () => {
  assert.deepEqual([...BUILD_YOUR_OWN_IDS], ['charging-agent', 'buying-compute']);
  for (const id of BUILD_YOUR_OWN_IDS) {
    const template = templateById(id);
    assert.ok(template, id);
    const limits = templateLimits(template!, 6);
    assert.equal(limits.cap > 0n, true);
    assert.equal(limits.max > 0n, true);
    assert.equal(limits.max <= limits.cap, true);
    assert.equal(limits.days >= 1, true);
    assert.equal(limits.purpose.length > 0, true);
    assert.equal(template!.fields.merchant, '');
  }
});

test('approval stays off until the payee, the agent, the purpose, the expiry, and every check are ready', () => {
  const checks = evaluatePresign(readyObservation());
  const ready = { checks, payeeReady: true, agentReady: true, purposeReady: true, expiryReady: true };
  assert.equal(canApprove(ready), true);
  assert.equal(canApprove({ ...ready, payeeReady: false }), false);
  assert.equal(canApprove({ ...ready, agentReady: false }), false);
  assert.equal(canApprove({ ...ready, purposeReady: false }), false);
  assert.equal(canApprove({ ...ready, expiryReady: false }), false);
  const blocked = evaluatePresign(readyObservation({ ownerTokenBalance: 0n }));
  assert.equal(canApprove({ ...ready, checks: blocked }), false);
});

test('an empty agent is allowed and the payee has to be a canonical address that is not the default', () => {
  const payee = Keypair.generate().publicKey.toBase58();
  const owner = Keypair.generate().publicKey.toBase58();
  assert.equal(agentFieldReady('', owner, payee), true);
  assert.equal(agentFieldReady(owner, owner, payee), false);
  assert.equal(agentFieldReady(payee, owner, payee), false);
  assert.equal(payeeFieldReady(payee), true);
  assert.equal(payeeFieldReady(''), false);
  assert.equal(payeeFieldReady(PublicKey.default.toBase58()), false);
});

test('the first-run introduction hides the tab bar and a connected owner does not', () => {
  assert.equal(
    introductionHidesTabBar({ walletReady: true, onboardingReady: true, connected: false, seen: false }),
    true,
  );
  assert.equal(
    introductionHidesTabBar({ walletReady: true, onboardingReady: true, connected: true, seen: false }),
    false,
  );
  assert.equal(
    introductionHidesTabBar({ walletReady: true, onboardingReady: true, connected: false, seen: true }),
    false,
  );
  assert.equal(
    introductionHidesTabBar({ walletReady: false, onboardingReady: true, connected: false, seen: false }),
    false,
  );
});
