import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatExport, SHARE_RULE_MISMATCH, type ExportContext } from './exportRecord';
import { parseBaseUnits } from './format';
import {
  applyRuleset,
  PAYEE_NOT_IN_RULESET,
  RULESET_ENVELOPE,
  stampAlignment,
  stampAlignmentLine,
  type Ruleset,
} from './ruleset';

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

const ENVELOPE_FIELDS = ['cap', 'per-payment maximum', 'expiry', 'purpose'];

test('issue 63: the stamp claims exactly the fields stampAlignment compares, and nothing else', () => {
  const lib = read('./ruleset.ts');
  const sig = /export function stampAlignment\(args: \{([\s\S]*?)\}\)/.exec(lib);
  assert.ok(sig, 'stampAlignment signature not found');
  const argKeys = [...sig[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(argKeys.sort(), ['cap', 'decimals', 'perTxMax', 'purpose', 'rulesets']);
  assert.doesNotMatch(lib, /\.merchant\s*===|===\s*\w+\.merchant/, 'ruleset.ts must not compare a payee');

  const detail = read('../app/rule/[address].tsx');
  assert.ok(
    detail.includes('The stamp claims the cap and per-payment maximum.'),
    'detail screen must say what the stamp claims',
  );
  assert.ok(detail.includes('PAYEE_NOT_IN_RULESET'), 'detail screen must say payee is not in the ruleset');
  assert.equal(stampAlignmentLine('limits-differ', 3), 'limits differ from ruleset v3 on this phone');
});

test('issue 63: apply, change payee, open, and the detail alignment is match', () => {
  const stored: Ruleset = {
    id: 'mint-budget',
    name: 'Mint budget',
    version: 1,
    cap: '100',
    perTxMax: '10',
    expiryDays: '7',
    merchant: 'PayeeA11111111111111111111111111111111111111',
    purpose: 'cap a mint bot',
  };
  const applied = applyRuleset(stored);
  const onChain = {
    purpose: applied.purpose,
    cap: parseBaseUnits(applied.cap, 6),
    perTxMax: parseBaseUnits(applied.perTxMax, 6),
    merchant: 'PayeeB11111111111111111111111111111111111111',
  };
  assert.notEqual(onChain.merchant, stored.merchant);
  const alignment = stampAlignment({
    purpose: onChain.purpose,
    cap: onChain.cap,
    perTxMax: onChain.perTxMax,
    decimals: 6,
    rulesets: [stored],
  });
  assert.equal(alignment?.alignment, 'match');
  assert.equal(stampAlignmentLine(alignment!.alignment, 1), 'matches ruleset v1 on this phone');
});

test('issue 63: every surface describes the same ruleset envelope and none puts the payee in it', () => {
  for (const field of ENVELOPE_FIELDS) {
    assert.ok(RULESET_ENVELOPE.includes(field), `envelope must name ${field}`);
  }
  assert.doesNotMatch(RULESET_ENVELOPE, /payee/i, 'the envelope must not list the payee');
  assert.match(PAYEE_NOT_IN_RULESET, /not part of the ruleset/);

  const surfaces = {
    '../app/rule/new.tsx': ['RULESET_ENVELOPE', 'PAYEE_NOT_IN_RULESET', 'PAYEE_PREFILL'],
    '../app/(tabs)/rules.tsx': ['RULESET_ENVELOPE', 'PAYEE_NOT_IN_RULESET', 'PAYEE_PREFILL'],
    '../app/help/index.tsx': ['RULESET_ENVELOPE', 'PAYEE_NOT_IN_RULESET', 'PAYEE_PREFILL'],
    '../app/rule/[address].tsx': ['PAYEE_NOT_IN_RULESET'],
  };
  for (const [rel, names] of Object.entries(surfaces)) {
    const text = read(rel);
    for (const name of names) {
      const uses = text.split(name).length - 1;
      assert.ok(uses >= 2, `${rel} must import and render ${name}, found ${uses} occurrence(s)`);
    }
    assert.doesNotMatch(
      text,
      /ruleset[^.]{0,80}\bpayee\b[^.]{0,40}\b(is|are) part\b/i,
      `${rel} must not say the payee is part of a ruleset`,
    );
  }

  const newScreen = read('../app/rule/new.tsx');
  const payeeField = /label="Payee"[\s\S]*?\/>/.exec(newScreen);
  assert.ok(payeeField, 'Payee field not found');
  assert.doesNotMatch(payeeField[0], /editable=\{!applying\}/, 'Payee must stay editable while applying');
  for (const label of ['Cap', 'Per-payment maximum', 'Expiry (days from now)', 'Purpose']) {
    const field = new RegExp(`label="${label.replace(/[()]/g, '\\$&')}"[\\s\\S]*?\\/>`).exec(newScreen);
    assert.ok(field, `${label} field not found`);
    assert.match(field[0], /editable=\{!applying\}/, `${label} must lock while applying`);
  }
});

test('issue 64: the mismatch empty state is rendered before the chooser, and export is guarded before formatExport', () => {
  const src = read('../app/share.tsx');
  const rendered = src.indexOf('<EmptyState>{SHARE_RULE_MISMATCH}</EmptyState>');
  const chooser = src.indexOf('What do you want to prove?');
  const exportButton = src.search(/label=\{\s*shape === 'csv'\s*\? `Export /);
  assert.notEqual(rendered, -1, 'share.tsx must render SHARE_RULE_MISMATCH as an EmptyState');
  assert.notEqual(chooser, -1);
  assert.notEqual(exportButton, -1);
  assert.ok(rendered < chooser, 'the mismatch empty state must come before the chooser branch');
  assert.ok(chooser < exportButton, 'the export button must live inside the chooser branch');

  const onExport = src.indexOf('const onExport');
  const guard = src.indexOf('throw new Error(SHARE_RULE_MISMATCH)');
  const format = src.indexOf('formatExport({');
  assert.ok(onExport !== -1 && guard !== -1 && format !== -1);
  assert.ok(onExport < guard && guard < format, 'onExport must throw the mismatch before formatExport');

  assert.equal(
    SHARE_RULE_MISMATCH,
    'This decision belongs to a rule that is not selected. Switch on the Rules tab first.',
  );
});

test('issue 64: why the gate matters, an empty decision export still throws the missing-signature line', () => {
  const ctx: ExportContext = {
    cluster: 'devnet',
    genesisHash: 'g',
    programId: 'p',
    mandate: {
      address: 'Selected1111111111111111111111111111111111',
      purpose: 'x',
    } as unknown as ExportContext['mandate'],
  };
  assert.throws(
    () =>
      formatExport({
        rows: [],
        scope: { type: 'decision', nonce: 1n, kind: 'paid', timestamp: 1000n },
        shape: 'json',
        ctx,
      }),
    /no transaction signature/,
  );
});
