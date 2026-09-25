const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// The Hold screens read the program description that ships with the vault client.
config.watchFolders = [path.resolve(projectRoot, '../sdk/idl')];

module.exports = config;
