// Installed package com.solanamobile.wallet registers an auto-verified App Link:
// MWABottomSheetActivity, scheme https, host connect.solanamobile.com,
// path prefix /v1/associate.
// The same package is named in
// https://connect.solanamobile.com/.well-known/assetlinks.json
// Mobile Wallet Adapter appends /v1/associate/local to this base, which matches
// that path prefix and opens this wallet instead of the system chooser.
export const SOLANA_MOBILE_WALLET_PACKAGE = 'com.solanamobile.wallet';
export const SOLANA_MOBILE_WALLET_BASE_URI = 'https://connect.solanamobile.com';

type InstalledPackageNative = {
  isInstalled(packageName: string): Promise<boolean>;
};

export async function isSolanaMobileWalletInstalled(): Promise<boolean> {
  try {
    const { requireNativeModule } = await import('expo-modules-core');
    const native = requireNativeModule<InstalledPackageNative>('InstalledPackage');
    return Boolean(await native.isInstalled(SOLANA_MOBILE_WALLET_PACKAGE));
  } catch {
    return false;
  }
}
