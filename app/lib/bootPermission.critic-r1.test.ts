import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Cross-vendor verification of PR 185, round 1. The decision scan is an
// expo-background-task, which runs on WorkManager
// (node_modules/expo-background-task/android/build.gradle:19,
// androidx.work:work-runtime-ktx:2.9.1). WorkManager schedules its jobs with
// setPersisted(false) and re-enqueues them from RescheduleReceiver on
// android.intent.action.BOOT_COMPLETED (work-runtime-2.9.1.aar
// AndroidManifest.xml:25 and :111-117). That receiver only fires when the app
// holds android.permission.RECEIVE_BOOT_COMPLETED. Blocking it in
// android.blockedPermissions writes tools:node="remove" into the merged
// manifest, so after a reboot the 15 minute scan is gone until the owner opens
// the app. The other four blocked permissions are not in this case on purpose.
test('the release config keeps RECEIVE_BOOT_COMPLETED so the background scan survives a reboot', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
    expo?: { android?: { blockedPermissions?: unknown } };
  };
  const raw = app.expo?.android?.blockedPermissions;
  const blocked = Array.isArray(raw) ? raw.map(String) : [];
  assert.equal(
    blocked.includes('android.permission.RECEIVE_BOOT_COMPLETED'),
    false,
    'RECEIVE_BOOT_COMPLETED is blocked; WorkManager needs it to reschedule the decision scan after a reboot',
  );
});
