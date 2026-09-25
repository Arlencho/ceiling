import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, space } from '../theme';
import { HoldInput, HoldSign, HoldTop, StatusBlock } from './chrome';

export function SendScreen({
  network,
  status,
  error,
  amountText,
  destinationText,
  headline,
  lines,
  onAmount,
  onDestination,
  onBack,
  onSign,
  signLabel,
  signingDisabled = false,
  tokenName,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  amountText: string;
  destinationText: string;
  headline: string | null;
  lines: readonly string[];
  onAmount: (text: string) => void;
  onDestination: (text: string) => void;
  onBack: () => void;
  onSign: () => Promise<void>;
  signLabel: string;
  signingDisabled?: boolean;
  tokenName?: string;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="Send from the vault" network={network} onBack={onBack} />
      <StatusBlock status={status} error={error} empty="This vault could not be read.">
        <Text style={styles.h1}>Ask the vault to send.</Text>
        <Text style={styles.body}>
          Small and familiar can leave at once. Big, new, or over your everyday limit waits. You sign
          with your key. The guardian key cannot start a withdrawal.
        </Text>
        <HoldInput
          label="Amount"
          value={amountText}
          onChangeText={onAmount}
          hint={tokenName ? `How much ${tokenName} leaves your vault.` : 'How much leaves your vault.'}
        />
        <HoldInput
          label="Destination address"
          value={destinationText}
          onChangeText={onDestination}
          hint="A wallet address, or the token account that receives it. A new address waits."
        />
        {headline ? <Text style={styles.headline}>{headline}</Text> : null}
        {lines.map((line) => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}
        <HoldSign
          name="send"
          label={signLabel}
          hint="You sign on this phone. Veto never sees your key."
          disabled={signingDisabled || headline === null}
          onSign={onSign}
        />
      </StatusBlock>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  h1: { color: colors.bone, fontFamily: fonts.serifRegular, fontSize: 30, lineHeight: 34 },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  headline: { color: colors.bone, fontFamily: fonts.sansSemibold, fontSize: 15, lineHeight: 21 },
  line: { color: colors.amber, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
});
