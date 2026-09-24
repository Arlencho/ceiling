import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  JOURNEY_PARTIAL_NAME,
  JOURNEY_TEMP_NAME,
  journeyReportPaths,
  publishJourneyReport,
  type JourneyReportPaths,
} from '../e2e/runReport';

const COMMITTED = '# Devnet journey\n\nRun started: 2026-09-24T01:07:39.559Z\n| setup | fund owner | sig | pass | funded |\n';

const EMPTY_TABLE = [
  '# Devnet journey',
  '',
  'Run started: 2026-09-24T02:51:27.242Z',
  'Owner: not funded yet',
  'Agent: not funded yet',
  'Rule A: not opened yet',
  'Rule B: not opened yet',
  '',
  '| Step | Action | Signature | Result | Detail |',
  '| --- | --- | --- | --- | --- |',
  '',
].join('\n');

function sandbox(): { dir: string; paths: JourneyReportPaths } {
  const dir = mkdtempSync(join(tmpdir(), 'veto-report-'));
  const paths = journeyReportPaths(dir);
  writeFileSync(paths.committed, COMMITTED);
  return { dir, paths };
}

test('a failed run leaves the committed table in place and keeps the partial table', () => {
  const { dir, paths } = sandbox();
  try {
    publishJourneyReport(paths, EMPTY_TABLE, 'writing');
    assert.equal(readFileSync(paths.committed, 'utf8'), COMMITTED);
    publishJourneyReport(paths, EMPTY_TABLE, 'failed');
    assert.equal(readFileSync(paths.committed, 'utf8'), COMMITTED);
    assert.equal(readFileSync(paths.partial, 'utf8'), EMPTY_TABLE);
    assert.equal(existsSync(paths.temporary), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that stops before any step does not create a committed table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veto-report-'));
  const paths = journeyReportPaths(dir);
  try {
    publishJourneyReport(paths, EMPTY_TABLE, 'failed');
    assert.equal(existsSync(paths.committed), false);
    assert.equal(readFileSync(paths.partial, 'utf8'), EMPTY_TABLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('progress during a run stays in the temporary file', () => {
  const { dir, paths } = sandbox();
  try {
    publishJourneyReport(paths, EMPTY_TABLE, 'writing');
    assert.equal(readFileSync(paths.committed, 'utf8'), COMMITTED);
    assert.equal(readFileSync(paths.temporary, 'utf8'), EMPTY_TABLE);
    assert.equal(existsSync(paths.partial), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a completed run replaces the committed table and removes the partial file', () => {
  const { dir, paths } = sandbox();
  const done = `${COMMITTED}| 9 | close rule B | sig | pass | returned |\n`;
  try {
    writeFileSync(paths.partial, EMPTY_TABLE);
    publishJourneyReport(paths, done, 'writing');
    assert.equal(readFileSync(paths.committed, 'utf8'), COMMITTED);
    publishJourneyReport(paths, done, 'complete');
    assert.equal(readFileSync(paths.committed, 'utf8'), done);
    assert.equal(existsSync(paths.temporary), false);
    assert.equal(existsSync(paths.partial), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the partial table and the temporary report are gitignored', () => {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  for (const name of [JOURNEY_PARTIAL_NAME, JOURNEY_TEMP_NAME]) {
    const rel = `app/e2e/${name}`;
    const ignored = execFileSync('git', ['check-ignore', '-v', '--', rel], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.match(ignored, new RegExp(name.replace(/[.]/g, '\\.')));
  }
});

test('the devnet journey publishes the table through the report helper', () => {
  const source = readFileSync(new URL('../e2e/devnetJourney.test.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/runReport'/);
  assert.match(source, /publishJourneyReport\(reportPaths, reportBody\(\), 'writing'\)/);
  assert.match(source, /publishJourneyReport\(reportPaths, reportBody\(\), journeyError \? 'failed' : 'complete'\)/);
  assert.doesNotMatch(source, /writeFileSync\(\s*REPORT\b/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*last-run\.md/);
});
