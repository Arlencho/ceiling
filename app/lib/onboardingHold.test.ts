import assert from 'node:assert/strict';
import test from 'node:test';
import {
  holdOnboardingNext,
  rememberHoldChoice,
  secondSeekerSetup,
  protectStep,
  holdSetupDone,
} from './onboardingHold';

test('Hold is offered once and skipping stays skipped after reopening', async () => {
  const values = new Map<string, string>();
  const store = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    deleteItem: async (key: string) => {
      values.delete(key);
    },
  };
  assert.equal(await holdOnboardingNext(store, 'owner'), '/first-run/protect');
  await rememberHoldChoice(store, 'owner');
  assert.equal(await holdOnboardingNext(store, 'owner'), '/first-run/finish');
  assert.equal(await holdOnboardingNext(store, 'owner'), '/first-run/finish');
});

test('second Seeker setup carries its address into the shared Hold flow', () => {
  assert.deepEqual(secondSeekerSetup('  11111111111111111111111111111111  '), {
    pathname: '/hold/amount',
    params: { onboarding: '1', guardian: '11111111111111111111111111111111', mode: 'seeker' },
  });
});

test('finishing Hold returns to onboarding only for onboarding setup', () => {
  assert.equal(holdSetupDone(true), '/first-run/finish');
  assert.equal(holdSetupDone(false), '/hold');
});

test('leaving Hold setup during onboarding returns to the offer with the pasted address kept', () => {
  assert.deepEqual(protectStep('  So11111111111111111111111111111111111111112  '), {
    pathname: '/first-run/protect',
    params: { guardian: 'So11111111111111111111111111111111111111112' },
  });
  assert.deepEqual(protectStep(''), { pathname: '/first-run/protect', params: {} });
});
