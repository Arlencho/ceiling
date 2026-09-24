const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const cryptoShim = path.resolve(__dirname, 'shims/node-crypto.js');
const sdkRoot = path.resolve(__dirname, '../sdk');

config.watchFolders = [sdkRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(sdkRoot, 'node_modules'),
];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'node:crypto') {
    return { type: 'sourceFile', filePath: cryptoShim };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
