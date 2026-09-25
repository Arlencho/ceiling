import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { readScannedText, ruleRequestHref } from '../lib/ruleRequest';
import { colors, fonts, radii } from './theme';

export function AddressActions({
  target,
  onAddress,
  onInvalid,
}: {
  target: 'agent' | 'payee';
  onAddress: (address: string) => void;
  onInvalid: (reason: string) => void;
}) {
  const router = useRouter();
  const noun = target === 'agent' ? "your agent's address" : 'the payee address';

  const paste = async () => {
    let text = '';
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      onInvalid('The clipboard could not be read.');
      return;
    }
    const read = readScannedText(text);
    if (read.kind === 'request') {
      const href = ruleRequestHref(read.url);
      if (href) {
        router.push(href);
      }
      return;
    }
    if (read.kind === 'address') {
      onAddress(read.address);
      return;
    }
    onInvalid(read.reason);
  };

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Paste ${noun}`}
        onPress={() => {
          void paste();
        }}
        style={styles.step}
      >
        <Text style={styles.label}>Paste</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Scan ${noun}`}
        onPress={() => router.push(`/scan?target=${target}`)}
        style={styles.step}
      >
        <Text style={styles.label}>Scan</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  step: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  label: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.brass,
  },
});
