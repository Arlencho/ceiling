import assert from 'node:assert/strict';
import test from 'node:test';

import { applyTemplate, assertTemplateIsEmptyStart, TEMPLATES, templateById } from './templates';

test('each template prefills the five fields and leaves them editable copies', () => {
  for (const template of TEMPLATES) {
    const fields = applyTemplate(template);
    assert.equal(fields.cap, template.fields.cap);
    assert.equal(fields.perTxMax, template.fields.perTxMax);
    assert.equal(fields.expiryDays, template.fields.expiryDays);
    assert.equal(fields.merchant, template.fields.merchant);
    assert.equal(fields.purpose, template.fields.purpose);
    fields.cap = 'changed';
    assert.notEqual(template.fields.cap, 'changed');
  }
});

test('templates a Seeker owner recognises are present', () => {
  const titles = TEMPLATES.map((t) => t.title);
  assert.ok(titles.includes('Cap a mint bot'));
  assert.ok(titles.includes('Cap a quest-farm spend'));
  assert.ok(titles.includes('Cap an agent weekly outgoings'));
  assert.ok(titles.includes('Charge the car under a price'));
});

test('a template is an empty starting point and never ships history or prices', () => {
  for (const template of TEMPLATES) {
    assertTemplateIsEmptyStart(template);
    assert.equal(template.fields.merchant, '');
    const blob = JSON.stringify(template).toLowerCase();
    assert.equal(blob.includes('history'), false);
    assert.equal(blob.includes('transaction'), false);
    assert.equal(/\d+\.\d{4,}/.test(blob), false);
  }
});

test('templateById returns the mint bot starting point', () => {
  const found = templateById('mint-bot');
  assert.ok(found);
  assert.equal(found.fields.purpose, 'cap a mint bot');
});

test('trading bot is not a starting point', () => {
  assert.equal(templateById('trading-bot'), undefined);
  assert.equal(
    TEMPLATES.some((row) => row.id === 'trading-bot' || row.title === 'Trading bot'),
    false,
  );
});
