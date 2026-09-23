import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('production builds take versionCode from EAS and increment it', () => {
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')) as {
    cli?: { appVersionSource?: unknown };
    build?: { production?: { autoIncrement?: unknown } };
  };
  assert.equal(eas.cli?.appVersionSource, 'remote');
  assert.equal(eas.build?.production?.autoIncrement, true);
});
