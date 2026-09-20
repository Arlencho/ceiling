module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...(config.extra ?? {}),
    vetoRpc: process.env.EXPO_PUBLIC_VETO_RPC ?? '',
    vetoProgramId: process.env.EXPO_PUBLIC_VETO_PROGRAM_ID ?? '',
    vetoMint: process.env.EXPO_PUBLIC_VETO_MINT ?? '',
    vetoExplorerCluster: process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER ?? 'devnet',
    vetoMintDecimals: process.env.EXPO_PUBLIC_VETO_MINT_DECIMALS ?? '6',
  },
});
