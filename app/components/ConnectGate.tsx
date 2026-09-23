import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { showsIntroduction } from '../lib/onboarding';
import { useOnboarding } from '../lib/useOnboarding';
import { useWallet } from '../lib/useWallet';
import { Button } from './Button';
import { OnboardingCards } from './OnboardingCards';
import { colors, fonts } from './theme';

const THESIS =
  'The owner key lives in Seed Vault and never leaves it. The agent key holds authority and no funds.';

export function ConnectGate({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const onboarding = useOnboarding();
  const connected = wallet.ownerPublicKey !== null;

  if (!wallet.ready || !onboarding.ready) {
    return <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />;
  }

  if (showsIntroduction({ connected, seen: onboarding.seen })) {
    return (
      <OnboardingCards
        showConnect
        connectBusy={wallet.busy}
        onSkip={() => onboarding.markSeen()}
        onConnect={async () => {
          await onboarding.markSeen();
          try {
            await wallet.connect();
          } catch {
            // The flag is already stored. The Connect screen below shows the wallet error.
          }
        }}
      />
    );
  }

  if (!connected || !wallet.ownerPublicKey) {
    return (
      <View style={styles.block}>
        <Text style={styles.thesis}>{THESIS}</Text>
        <Button
          label={wallet.busy ? 'Connecting...' : 'Connect'}
          accessibilityLabel="Connect"
          busy={wallet.busy}
          onPress={() => {
            void wallet.connect();
          }}
        />
        {wallet.error ? <Text style={styles.error}>{wallet.error}</Text> : null}
      </View>
    );
  }

  return <View style={styles.block}>{children}</View>;
}

const styles = StyleSheet.create({
  block: {
    gap: 16,
    alignSelf: 'stretch',
    flex: 1,
  },
  thesis: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },
  error: {
    color: colors.body,
    fontSize: 14,
    lineHeight: 20,
  },
});
