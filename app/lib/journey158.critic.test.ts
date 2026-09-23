import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Path 4. The permissions in the release manifest come from Expo's bare
// template (expo/template.tgz, android/app/src/main/AndroidManifest.xml), not
// from the expo-dev-client plugin. Prebuild without that plugin still writes
// them. The config that removes them is android.blockedPermissions.
test('the release config blocks the template permissions the product does not use', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
    expo?: { android?: { blockedPermissions?: unknown } };
  };
  const raw = app.expo?.android?.blockedPermissions;
  const blocked = Array.isArray(raw) ? raw.map(String) : [];
  for (const permission of [
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]) {
    assert.ok(blocked.includes(permission), `${permission} is not in android.blockedPermissions`);
  }
});
