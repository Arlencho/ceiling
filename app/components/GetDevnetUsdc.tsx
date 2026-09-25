import * as Clipboard from 'expo-clipboard';
import { Linking, StyleSheet, Text, View } from 'react-native';

import {
  CIRCLE_DEVNET_FAUCET_URL,
  FAUCET_PASTE_LINE,
  GET_DEVNET_USDC_LABEL,
} from '../lib/faucet';
import { Button } from './Button';
import { colors, fonts, space } from './theme';

export function GetDevnetUsdc({ owner }: { owner: string }) {
  return (
    <View style={styles.block}>
      <Text accessibilityLabel={`Owner address ${owner}`} selectable style={styles.address}>
        {owner}
      </Text>
      <Button
        label="Copy"
        accessibilityLabel="Copy"
        invert={false}
        onPress={() => {
          void Clipboard.setStringAsync(owner).catch(() => undefined);
        }}
      />
      <Text style={styles.line}>{FAUCET_PASTE_LINE}</Text>
      <Button
        label={GET_DEVNET_USDC_LABEL}
        accessibilityLabel={GET_DEVNET_USDC_LABEL}
        onPress={() => {
          void Linking.openURL(CIRCLE_DEVNET_FAUCET_URL).catch(() => undefined);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: space.xl,
    alignSelf: 'stretch',
  },
  address: {
    color: colors.bone,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 18,
  },
  line: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
});
