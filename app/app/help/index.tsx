import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { PAYEE_NOT_IN_RULESET, PAYEE_PREFILL, RULESET_ENVELOPE } from '../../lib/ruleset';

export default function HelpRuleScreen() {
  const router = useRouter();
  return (
    <Screen>
      <TopBar back="Back" meta="1 of 3" />
      <Text style={styles.eyebrow}>A rule</Text>
      <Text style={styles.h2}>What a rule is</Text>
      <Text style={styles.body}>
        A rule is a spending limit you write in advance: how much in total, how much per payment,
        until when, and to which payee. The program on Solana enforces it. An agent can then pay
        inside that rule with nobody present.
      </Text>
      <Text style={styles.body}>
        The numbers are fixed once the rule is opened. They cannot be edited afterwards. An override
        does not change those numbers. It is a recorded waiver of the per-payment ceiling for one
        nonce. Revoke ends authority for the agent. It does not move anything already paid, and the
        decisions stay readable.
      </Text>
      <Text style={styles.body}>
        One owner can hold several rules at once. Each rule has its own agent key, its own limits,
        and its own decision history. A rule opened from this app keeps its budget in its own token
        account, so another rule on the same mint keeps its own delegate. Switching a rule changes
        what Overview and Decisions are about.
      </Text>
      <Text style={styles.body}>
        {`${RULESET_ENVELOPE} ${PAYEE_NOT_IN_RULESET} ${PAYEE_PREFILL} A rule you open still names a payee, because the program enforces it.`}
      </Text>
      <View style={styles.actions}>
        <Button label="Next" onPress={() => router.push('/help/refusal')} />
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
