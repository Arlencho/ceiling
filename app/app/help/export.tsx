import { useNavigation, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { finishHelpExport } from '../../lib/helpNavigation';

export default function HelpExportScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  return (
    <Screen>
      <TopBar back="Back" meta="3 of 3" help={false} />
      <Text style={styles.eyebrow}>The record</Text>
      <Text style={styles.h2}>What the export proves</Text>
      <Text style={styles.body}>
        Share is an action on a decision, not a tab. You choose what to prove: this decision, a
        date range, or everything under this rule. CSV opens in a spreadsheet. JSON is the
        documented decision record, which another machine can re-check against the chain.
      </Text>
      <Text style={styles.body}>
        Every exported row carries its own transaction signature, so any line can be taken back to
        the chain on its own. A bulk file that cannot be verified row by row is just a spreadsheet.
      </Text>
      <Text style={styles.body}>
        The record is complete over payments, never over attempts. A charge the agent never
        submitted cannot appear, and the export does not invent a row for a gap.
      </Text>
      <View style={styles.actions}>
        <Button
          label="Done"
          onPress={() => finishHelpExport(router, navigation.getState()?.routes ?? null)}
        />
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
