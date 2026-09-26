import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function generate(t, validator, replay = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scale-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, 'loadtest/offchain/run');
  const reports = join(root, 'loadtest/reports');
  await mkdir(run, { recursive: true });
  await mkdir(reports, { recursive: true });
  await mkdir(join(root, 'docs'));
  await copyFile(new URL('./scale.mjs', import.meta.url), join(run, 'scale.mjs'));
  for (const [name, report] of Object.entries({ cu: {}, validator, replay })) {
    await writeFile(join(reports, `${name}.json`), JSON.stringify(report));
  }
  execFileSync(process.execPath, [join(run, 'scale.mjs')]);
  return readFile(join(root, 'docs/SCALE.md'), 'utf8');
}

test('validator array rows include recorded provenance and leave absent Postgres unrecorded', async t => {
  const machine = { os: 'darwin', release: '25.6.0', arch: 'arm64', cpu: 'Apple M5', logicalCpus: 10, memoryBytes: 34359738368 };
  const entry = { machine, node: 'v22.23.3', commit: 'abc123', label: 'laptop lower bound', durationSeconds: 10 };
  const output = await generate(t, [{ ...entry, shape: 'distinct' }, { ...entry, shape: 'shared' }]);
  const rows = output.split('\n').filter(line => line.startsWith('- validator.'));
  assert.ok(rows.length > 0);
  const context = `machine=${JSON.stringify(machine)}; os=darwin 25.6.0; node=v22.23.3; postgres=not recorded; commit=abc123; duration=10 seconds; conditions=laptop lower bound; single-machine lower bound`;
  for (const row of rows) assert.equal(row.split(' | ')[1], context);
});

test('validator context preserves distinct recorded values and ignores absent values', async t => {
  const output = await generate(t, [{ node: 'v22', durationSeconds: 10 }, { node: 'v24', durationSeconds: 20 }, {}]);
  assert.ok(output.includes('node=v22 / v24; postgres=not recorded; commit=not recorded; duration=10 / 20 seconds; conditions=not recorded'));
});

test('object reports retain metadata context', async t => {
  const metadata = { machine: 'test CPU', os: 'linux', node: 'v22', postgres: '16', commit: 'def456', duration_seconds: 60, conditions: 'test conditions' };
  const output = await generate(t, [], { metadata, count: 42 });
  assert.ok(output.includes('- replay.count: 42 | machine=test CPU; os=linux; node=v22; postgres=16; commit=def456; duration=60 seconds; conditions=test conditions; single-machine lower bound'));
});
