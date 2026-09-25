import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const BRAND = {
  icon: './assets/brand/app-icon-1024.png',
  foreground: './assets/brand/adaptive-icon-foreground-1024.png',
  background: './assets/brand/adaptive-icon-background-1024.png',
  splash: './assets/brand/splash-mark-512.png',
} as const;

test('app.json points the icon, adaptive icon, and splash at the Catch brand assets', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
    expo: {
      icon?: string;
      android?: {
        adaptiveIcon?: {
          backgroundColor?: string;
          foregroundImage?: string;
          backgroundImage?: string;
        };
      };
      plugins?: unknown[];
    };
  };
  assert.equal(app.expo.icon, BRAND.icon);
  const adaptive = app.expo.android?.adaptiveIcon;
  assert.equal(adaptive?.foregroundImage, BRAND.foreground);
  assert.equal(adaptive?.backgroundImage, BRAND.background);
  assert.equal(adaptive?.backgroundColor, '#0F1A16');
  const splash = (app.expo.plugins ?? []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
  );
  assert.ok(splash, 'expo-splash-screen plugin is configured');
  const options = (splash as [string, { image?: string; backgroundColor?: string }])[1];
  assert.equal(options.image, BRAND.splash);
  assert.equal(options.backgroundColor, '#0F1A16');
  for (const relative of Object.values(BRAND)) {
    const file = new URL(`../${relative}`, import.meta.url);
    assert.equal(existsSync(file), true, `${relative} is missing`);
  }
});

test('the root layout keeps the splash up until Fraunces and Manrope are loaded', () => {
  const src = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(src, /preventAutoHideAsync/);
  assert.match(src, /hideAsync/);
  assert.match(src, /useFonts/);
  assert.match(src, /Fraunces_300Light/);
  assert.match(src, /Fraunces_400Regular/);
  assert.match(src, /Fraunces_500Medium/);
  assert.match(src, /Manrope_400Regular/);
  assert.match(src, /Manrope_700Bold/);
  assert.match(src, /getInitialURL/);
  assert.match(src, /addEventListener\(\s*'url'/);
  assert.match(src, /ruleRequestHref/);
});
