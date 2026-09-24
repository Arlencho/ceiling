import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { readScannedText, ruleRequestHref } from '../lib/ruleRequest';
import { Button } from './Button';

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
  const noun = target === 'agent' ? 'agent' : 'payee';

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
      <View style={styles.slot}>
        <Button
          label="Scan"
          accessibilityLabel={`Scan ${noun}`}
          invert={false}
          onPress={() => router.push(`/scan?target=${target}`)}
        />
      </View>
      <View style={styles.slot}>
        <Button
          label="Paste"
          accessibilityLabel={`Paste ${noun}`}
          invert={false}
          onPress={() => {
            void paste();
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  slot: {
    flex: 1,
  },
});
