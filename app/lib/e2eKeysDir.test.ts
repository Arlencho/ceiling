import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { readDeployerKey, resolveKeysDir } from '../e2e/keysDir';

test('an absolute VETO_KEYS_DIR is the keys folder', () => {
  const repo = '/tmp/veto-repo';
  const keys = '/tmp/veto-keys-absolute';
  assert.equal(resolveKeysDir(repo, { VETO_KEYS_DIR: keys }), keys);
});

test('a relative VETO_KEYS_DIR resolves from the repo root', () => {
  const repo = '/tmp/veto-repo';
  assert.equal(
    resolveKeysDir(repo, { VETO_KEYS_DIR: 'elsewhere/keys' }),
    resolve(repo, 'elsewhere/keys'),
  );
});

test('an unset VETO_KEYS_DIR uses the repo keys folder', () => {
  const repo = '/tmp/veto-repo';
  assert.equal(resolveKeysDir(repo, {}), join(repo, 'keys'));
});

test('an empty VETO_KEYS_DIR uses the repo keys folder', () => {
  const repo = '/tmp/veto-repo';
  assert.equal(resolveKeysDir(repo, { VETO_KEYS_DIR: '' }), join(repo, 'keys'));
});

test('an omitted env reads VETO_KEYS_DIR from the process environment', () => {
  const previous = process.env.VETO_KEYS_DIR;
  process.env.VETO_KEYS_DIR = '/tmp/veto-from-process';
  try {
    assert.equal(resolveKeysDir('/tmp/veto-repo'), '/tmp/veto-from-process');
  } finally {
    if (previous === undefined) delete process.env.VETO_KEYS_DIR;
    else process.env.VETO_KEYS_DIR = previous;
  }
});

test('the deployer key is read from VETO_KEYS_DIR, not the repo keys folder', () => {
  const repo = mkdtempSync(join(tmpdir(), 'veto-keys-repo-'));
  const keys = mkdtempSync(join(tmpdir(), 'veto-keys-dir-'));
  try {
    mkdirSync(join(repo, 'keys'));
    writeFileSync(join(repo, 'keys', 'deployer.json'), 'repo-key');
    writeFileSync(join(keys, 'deployer.json'), 'env-key');
    assert.equal(readDeployerKey(repo, { VETO_KEYS_DIR: keys }), 'env-key');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(keys, { recursive: true, force: true });
  }
});

test('a missing deployer key names the resolved path it tried', () => {
  const repo = mkdtempSync(join(tmpdir(), 'veto-keys-repo-'));
  try {
    const expected = resolve(repo, 'outside', 'deployer.json');
    assert.throws(
      () => readDeployerKey(repo, { VETO_KEYS_DIR: 'outside' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(expected), err.message);
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
