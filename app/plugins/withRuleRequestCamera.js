const { withAndroidManifest } = require('expo/config-plugins');

const CAMERA = 'android.permission.CAMERA';

function ensureCamera(manifest) {
  const root = manifest.manifest ?? {};
  const permissions = Array.isArray(root['uses-permission']) ? root['uses-permission'] : [];
  let found = false;
  for (const entry of permissions) {
    if (entry?.$?.['android:name'] !== CAMERA) {
      continue;
    }
    found = true;
    if (entry.$['tools:node'] === 'remove') {
      delete entry.$['tools:node'];
    }
  }
  if (!found) {
    permissions.push({ $: { 'android:name': CAMERA } });
  }
  root['uses-permission'] = permissions;
  manifest.manifest = root;
  return manifest;
}

function withRuleRequestCamera(config) {
  return withAndroidManifest(config, (next) => {
    next.modResults = ensureCamera(next.modResults);
    return next;
  });
}

module.exports = withRuleRequestCamera;
module.exports.ensureCamera = ensureCamera;
