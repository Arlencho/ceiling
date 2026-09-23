import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function styleBlock(src: string, name: string): string {
  const start = src.indexOf(`\n  ${name}: {`);
  assert.notEqual(start, -1, `style ${name} is declared`);
  const end = src.indexOf('\n  }', start);
  return src.slice(start, end);
}

test('r1 finding 2: the Copy control is at least 44 points tall and shows a pressed state', () => {
  const src = read('app/rule/[address].tsx');
  const pressable = src.slice(src.lastIndexOf('<Pressable', src.indexOf('accessibilityLabel="Copy agent address"')), src.indexOf('<Text style={styles.copy}>Copy</Text>'));
  assert.match(pressable, /accessibilityRole="button"/);
  const styleProp = pressable.match(/style=\{\(\{ pressed \}\) => \[styles\.(\w+), pressed && styles\.(\w+)\]\}/);
  assert.ok(styleProp, 'the Pressable takes a pressed-aware style callback');
  const [, hit, pressed] = styleProp;
  const hitBlock = styleBlock(src, hit!);
  const minHeight = Number(hitBlock.match(/minHeight: (\d+)/)?.[1]);
  assert.ok(minHeight >= 44, `${hit} minHeight ${minHeight} is at least 44`);
  const pressedBlock = styleBlock(src, pressed!);
  assert.match(pressedBlock, /opacity: 0?\.\d+|backgroundColor:/, `${pressed} changes something visible`);
});

test('r1 finding 3: the agent line is a Def, and the definition row chrome is declared once', () => {
  const src = read('app/rule/[address].tsx');
  for (const gone of ['agentRow', 'agentHead', 'agentAddress:']) {
    assert.doesNotMatch(src, new RegExp(gone), `${gone} is no longer a separate style`);
  }
  assert.equal(src.match(/borderTopWidth: 1/g)?.length, 1, 'one row border declaration');
  assert.equal(src.match(/paddingVertical: 9/g)?.length, 1, 'one row padding declaration');
  const agentDef = src.slice(src.indexOf('label="Agent"'), src.indexOf('</Def>') === -1 ? src.indexOf('styles.keys') : src.indexOf('</Def>'));
  assert.match(agentDef, /value=\{mandate\.agent\}/, 'the whole agent address is the Def value');
  assert.match(agentDef, /\n\s+stacked\n/, 'the agent Def is stacked');
  assert.match(agentDef, /action=\{/, 'the copy control is the Def action');
  const defFn = src.slice(src.indexOf('function Def('), src.indexOf('const styles ='));
  assert.equal(src.match(/styles\.defK/g)?.length, defFn.match(/styles\.defK/g)?.length, 'defK is only applied inside Def');
  assert.match(defFn, /<Text selectable style=\{\[styles\.defV/, 'the value stays selectable');
});

test('r1 finding 1 regression: the write inside copyAgentAddress goes through expo-clipboard', () => {
  const src = read('app/rule/[address].tsx');
  assert.match(src, /^import \* as Clipboard from 'expo-clipboard';/m);
  assert.doesNotMatch(src, /import \{[^}]*\bClipboard\b[^}]*\} from 'react-native'/);
  assert.match(
    src,
    /await copyAgentAddress\(mandate\.agent, async \(value\) => \{\s*await Clipboard\.setStringAsync\(value\);\s*\}\)/,
    'the clipboard write stays inside the guarded callback, so a truncated spelling is still refused before any write',
  );
});

test('expo-clipboard is declared, locked, matches the SDK bundled range, and carries an android autolinking config', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
  const declared = pkg.dependencies['expo-clipboard'];
  assert.ok(declared, 'expo-clipboard is a runtime dependency');
  assert.equal(pkg.devDependencies?.['expo-clipboard'], undefined, 'not a dev dependency');
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version: string }> };
  const locked = lock.packages['node_modules/expo-clipboard'];
  assert.ok(locked, 'expo-clipboard is in the lockfile');
  const require = createRequire(join(ROOT, 'package.json'));
  const bundled = require('expo/bundledNativeModules.json') as Record<string, string>;
  assert.equal(declared, bundled['expo-clipboard'], 'the declared range is the one the installed expo SDK bundles');
  const installed = require('expo-clipboard/package.json') as { version: string };
  assert.equal(installed.version, locked.version, 'the resolved module is the locked version');
  const configPath = join(require.resolve('expo-clipboard/package.json'), '..', 'expo-module.config.json');
  assert.ok(existsSync(configPath), 'expo-module.config.json exists, so autolinking picks the module up in a prebuild');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { platforms: string[] };
  assert.ok(config.platforms.includes('android'), 'android platform is declared for the APK build profiles');
});
