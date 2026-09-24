import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ensureCamera } = require('../plugins/withRuleRequestCamera.js') as {
  ensureCamera: (manifest: {
    manifest: { 'uses-permission'?: Array<{ $: Record<string, string> }> };
  }) => {
    manifest: { 'uses-permission'?: Array<{ $: Record<string, string> }> };
  };
};
const { shapeConfig } = require('../app.config.js') as {
  shapeConfig: (
    config: { plugins?: unknown[]; extra?: Record<string, unknown> },
    env: Record<string, string | undefined>,
  ) => { plugins: unknown[] };
};

test('the production config keeps the camera plugin, the camera permission, and no microphone', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
    expo: {
      plugins?: unknown[];
      android?: { blockedPermissions?: string[]; softwareKeyboardLayoutMode?: string };
    };
  };
  const blocked = app.expo.android?.blockedPermissions ?? [];
  assert.equal(blocked.includes('android.permission.CAMERA'), false);
  assert.equal(app.expo.android?.softwareKeyboardLayoutMode, 'resize');
  const camera = (app.expo.plugins ?? []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-camera',
  );
  assert.ok(camera, 'expo-camera plugin is configured');
  const options = (camera as [string, { recordAudioAndroid?: boolean; barcodeScannerEnabled?: boolean }])[1];
  assert.equal(options.recordAudioAndroid, false);
  assert.equal(options.barcodeScannerEnabled, true);
  const names = (pluginList: unknown[]) =>
    pluginList.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  const production = shapeConfig(app.expo, { EAS_BUILD_PROFILE: 'production' });
  assert.ok(names(production.plugins).includes('expo-camera'));
  assert.ok(names(production.plugins).includes('./plugins/withRuleRequestCamera.js'));
  assert.equal(names(production.plugins).includes('expo-dev-client'), false);

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const bundled = require('expo/bundledNativeModules.json') as Record<string, string>;
  assert.equal(pkg.dependencies['expo-camera'], bundled['expo-camera']);
  const installed = require('expo-camera/package.json') as { version: string };
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
    packages: Record<string, { version: string }>;
  };
  assert.equal(installed.version, lock.packages['node_modules/expo-camera']?.version);
  const configPath = join(require.resolve('expo-camera/package.json'), '..', 'expo-module.config.json');
  assert.ok(existsSync(configPath));
  const moduleConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { platforms?: string[] };
  assert.ok(moduleConfig.platforms?.includes('android'));
});

test('the manifest plugin adds CAMERA and does not leave it removed', () => {
  const removed = ensureCamera({
    manifest: {
      'uses-permission': [{ $: { 'android:name': 'android.permission.CAMERA', 'tools:node': 'remove' } }],
    },
  });
  const kept = removed.manifest['uses-permission']?.find((entry) => entry.$['android:name'] === 'android.permission.CAMERA');
  assert.ok(kept);
  assert.equal(kept?.$['tools:node'], undefined);

  const added = ensureCamera({ manifest: { 'uses-permission': [] } });
  assert.equal(
    added.manifest['uses-permission']?.some((entry) => entry.$['android:name'] === 'android.permission.CAMERA'),
    true,
  );
});

test('a rule screen keeps the focused field and the primary button clear of the keyboard', () => {
  const screen = readFileSync(new URL('../components/RuleScreen.tsx', import.meta.url), 'utf8');
  assert.match(screen, /KeyboardAvoidingView/);
  assert.match(screen, /scrollTo\(/);
  const field = readFileSync(new URL('../components/Field.tsx', import.meta.url), 'utf8');
  assert.match(field, /onFocus=/);
  assert.match(field, /scrollFocused/);
  const tabs = readFileSync(new URL('../app/(tabs)/_layout.tsx', import.meta.url), 'utf8');
  assert.match(tabs, /introductionHidesTabBar/);
  assert.match(tabs, /display:\s*'none'/);
});
