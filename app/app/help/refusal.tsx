import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';

export default function HelpRefusalScreen() {
  const router = useRouter();
  return (
    <Screen>
      <TopBar back="Back" meta="2 of 3" />
      <Text style={styles.eyebrow}>A recorded no</Text>
      <Text style={styles.h2}>Why a refusal is recorded</Text>
      <Text style={styles.body}>
        When a payment would break the rule, the program does not pay. It records the refusal on
        chain with the reason and the override that would have cleared it. Elsewhere the same
        block is a failed transaction that leaves no trace. Here the no is the product.
      </Text>
      <Text style={styles.body}>
        A refusal is a success. It is the rule holding. It is never an error.
      </Text>
      <Text style={styles.h2}>The two keys</Text>
      <Text style={styles.body}>
        The owner key lives in Seed Vault and never leaves it. It is the only key that can open a
        rule, grant an override, or revoke.
      </Text>
      <Text style={styles.body}>
        The agent key holds authority and none of your money. It can pay inside the rule, and nothing else.
        It cannot widen any limit. Each rule has its own agent. An override the owner grants is a
        recorded decision for one nonce, not a settings change. The per-payment ceiling rises for
        that charge only. The total cap does not.
      </Text>
      <View style={styles.actions}>
        <Button label="Next" onPress={() => router.push('/help/export')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
    marginTop: 8,
  },
  body: {
    color: colors.body,
    fontSize: 16,
    lineHeight: 24,
  },
  actions: {
    marginTop: 12,
  },
});
