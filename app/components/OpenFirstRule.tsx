import { StyleSheet, Text, View } from 'react-native';

import { OPEN_FIRST_RULE_LABEL, OPEN_FIRST_RULE_NEXT } from '../lib/onboarding';
import { Button } from './Button';
import { colors, fonts } from './theme';

export function OpenFirstRule({ onOpen }: { onOpen: () => void }) {
  return (
    <View style={styles.block}>
      <Text style={styles.next}>{OPEN_FIRST_RULE_NEXT}</Text>
      <Button
        label={OPEN_FIRST_RULE_LABEL}
        accessibilityLabel={OPEN_FIRST_RULE_LABEL}
        onPress={onOpen}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 16,
    alignSelf: 'stretch',
  },
  next: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },
});
