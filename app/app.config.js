const { withProductionDevClientScheme } = require('./plugins/withoutDevClientScheme');

function pluginName(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function shapeConfig(config, env) {
  const production = env.EAS_BUILD_PROFILE === 'production';
  const plugins = [...(config.plugins ?? [])];
  const nextPlugins = production
    ? [
        withProductionDevClientScheme,
        ...plugins.filter((plugin) => pluginName(plugin) !== 'expo-dev-client'),
      ]
    : plugins;
  return {
    ...config,
    plugins: nextPlugins,
    extra: {
      ...(config.extra ?? {}),
      vetoRpc: env.EXPO_PUBLIC_VETO_RPC ?? '',
      vetoProgramId: env.EXPO_PUBLIC_VETO_PROGRAM_ID ?? '',
      vetoMint: env.EXPO_PUBLIC_VETO_MINT ?? '',
      vetoExplorerCluster: env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER ?? 'devnet',
      vetoMintDecimals: env.EXPO_PUBLIC_VETO_MINT_DECIMALS ?? '6',
    },
  };
}

function build(ctx) {
  return shapeConfig(ctx.config, process.env);
}

build.shapeConfig = shapeConfig;
module.exports = build;
