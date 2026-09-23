import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DECISION_NOTIFICATION_EXPLANATION, explainOnceThenAsk } from './notificationAsk';

const ruleScreen = readFileSync(new URL('../app/rule/[address].tsx', import.meta.url), 'utf8');

test('the rule screen explains notifications once, before the permission dialog', () => {
  assert.match(DECISION_NOTIFICATION_EXPLANATION, /notification permission/i);
  assert.match(DECISION_NOTIFICATION_EXPLANATION, /15 minutes/);
  assert.match(DECISION_NOTIFICATION_EXPLANATION, /battery optimisation/);
  assert.match(ruleScreen, /\{DECISION_NOTIFICATION_EXPLANATION\}/);
  assert.match(ruleScreen, /explainOnceThenAsk/);
  assert.doesNotMatch(ruleScreen, /void askAfterFirstRuleOpened\(\)/);
});

test('the explanation is shown once and the permission ask waits for it', async () => {
  const events: string[] = [];
  let release = (): void => {
    throw new Error('explanation was not shown');
  };
  const pending = explainOnceThenAsk({
    alreadyAsked: false,
    showExplanation: async (copy) => {
      events.push(copy);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    ask: async () => {
      events.push('ask');
    },
  });
  await Promise.resolve();
  assert.equal(events.length, 1);
  assert.match(events[0] ?? '', /notification/i);
  assert.match(events[0] ?? '', /15 minutes/);
  assert.match(events[0] ?? '', /battery optimisation/);
  assert.equal(events.includes('ask'), false);
  release();
  await pending;
  assert.deepEqual(events.slice(1), ['ask']);

  const again: string[] = [];
  await explainOnceThenAsk({
    alreadyAsked: true,
    showExplanation: async () => {
      again.push('explain');
    },
    ask: async () => {
      again.push('ask');
    },
  });
  assert.deepEqual(again, ['ask']);
});
