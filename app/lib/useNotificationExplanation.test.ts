import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';

import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

// The line after the permission dialog is what the owner reads on the rule
// screen. These cases drive that line from getPermissionsAsync.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTIFICATIONS_OFF_LINE = 'Notifications are off, nothing is announced';
const NOTIFICATION_CADENCE_LINE =
  'Background checks run about every 15 minutes and can be delayed by battery optimisation.';

let alreadyAsked = false;
let permissionGranted = false;
let askCalls = 0;

mock.module('expo-notifications', {
  namedExports: {
    getPermissionsAsync: async () => ({ granted: permissionGranted }),
  },
});

mock.module('./decisionNotifyTask', {
  namedExports: {
    hasAskedForDecisionNotifications: async () => alreadyAsked,
    askAfterFirstRuleOpened: async () => {
      askCalls += 1;
    },
  },
});

type Explanation = {
  explanation: string | null;
  statusLine: string | null;
  onContinue: () => void;
};

type Out = { view: Explanation | null };

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(address: string): Promise<{ root: ReactTestRenderer; out: Out }> {
  const hook = await import('./useNotificationExplanation');
  const out: Out = { view: null };
  let root: ReactTestRenderer | null = null;
  function Harness(props: { address: string; out: Out }) {
    props.out.view = hook.useNotificationExplanation(props.address);
    return null;
  }
  await act(async () => {
    root = create(createElement(Harness, { address, out }));
    await flush();
  });
  assert.ok(root);
  return { root, out };
}

test('the rule screen renders the permission line from the notification explanation hook', () => {
  const screen = readFileSync(new URL('../app/rule/[address].tsx', import.meta.url), 'utf8');
  assert.match(screen, /useNotificationExplanation\(/);
  assert.match(screen, /\{notify\.explanation\}/);
  assert.match(screen, /\{notify\.statusLine\}/);
  assert.doesNotMatch(screen, /explainOnceThenAsk/);
  assert.doesNotMatch(screen, /askAfterFirstRuleOpened/);
});

test('before Continue, the rule screen explains notification permission and does not yet say notifications are off', async () => {
  alreadyAsked = false;
  permissionGranted = false;
  askCalls = 0;
  const { out } = await mount('Mandate1111111111111111111111111111111111111');
  assert.match(out.view?.explanation ?? '', /notification permission/i);
  assert.match(out.view?.explanation ?? '', /15 minutes/);
  assert.match(out.view?.explanation ?? '', /battery optimisation/);
  assert.equal(out.view?.statusLine, null);
  assert.equal(askCalls, 0);
});

test('after the owner denies notification permission, the rule screen says notifications are off and nothing is announced', async () => {
  alreadyAsked = false;
  permissionGranted = false;
  askCalls = 0;
  const { out } = await mount('Mandate1111111111111111111111111111111111111');
  await act(async () => {
    out.view?.onContinue();
    await flush();
  });
  assert.equal(out.view?.explanation, null);
  assert.equal(out.view?.statusLine, NOTIFICATIONS_OFF_LINE);
  assert.equal(askCalls, 1);
});

test('after notification permission is granted, the rule screen says checks run about every 15 minutes and can be delayed by battery', async () => {
  alreadyAsked = false;
  permissionGranted = true;
  askCalls = 0;
  const { out } = await mount('Mandate1111111111111111111111111111111111111');
  await act(async () => {
    out.view?.onContinue();
    await flush();
  });
  assert.equal(out.view?.explanation, null);
  assert.equal(out.view?.statusLine, NOTIFICATION_CADENCE_LINE);
});

test('opening a rule again after a denial still says notifications are off and nothing is announced', async () => {
  alreadyAsked = true;
  permissionGranted = false;
  askCalls = 0;
  const { out } = await mount('Mandate1111111111111111111111111111111111111');
  assert.equal(out.view?.explanation, null);
  assert.equal(out.view?.statusLine, NOTIFICATIONS_OFF_LINE);
});

test('opening a rule again after a grant still says checks run about every 15 minutes and can be delayed by battery', async () => {
  alreadyAsked = true;
  permissionGranted = true;
  askCalls = 0;
  const { out } = await mount('Mandate1111111111111111111111111111111111111');
  assert.equal(out.view?.explanation, null);
  assert.equal(out.view?.statusLine, NOTIFICATION_CADENCE_LINE);
});
