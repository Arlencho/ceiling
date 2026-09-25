import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { HoldInput, HoldSteps, HoldTop, StatusBlock } from './chrome';

export function AmountScreen({
  network,
  status,
  error,
  amountText,
  balanceLabel,
  tokenName,
  walletLabel,
  onAmount,
  onBack,
  onNext,
  faucet,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  amountText: string;
  balanceLabel: string | null;
  tokenName: string;
  walletLabel: string;
  onAmount: (text: string) => void;
  onBack: () => void;
  onNext: () => void;
  faucet?: ReactNode;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="New Hold vault" network={network} onBack={onBack} />
      <HoldSteps current={0} />
      <StatusBlock status={status} error={error} empty="No token account was found for this wallet.">
        <Text style={styles.h1}>Move money into the vault.</Text>
        <Text style={styles.body}>
          {balanceLabel
            ? `Your wallet ${walletLabel} holds ${balanceLabel} ${tokenName}. Only what you move in is protected.`
            : `Your wallet ${walletLabel} has no ${tokenName} account yet.`}
        </Text>
        <HoldInput
          label={`Amount of ${tokenName}`}
          value={amountText}
          onChangeText={onAmount}
          hint="This is the amount moving into your vault, from your wallet."
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Next: set the rules" onPress={onNext} style={styles.cta}>
          <Text style={styles.ctaText}>Next: set the rules</Text>
        </Pressable>
      </StatusBlock>
      {faucet}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xl },
  h1: {
    color: colors.bone,
    fontFamily: fonts.serifRegular,
    fontSize: 32,
    lineHeight: 36,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  cta: {
    height: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    color: colors.forest,
    fontFamily: fonts.sansBold,
    fontSize: 17,
  },
});
