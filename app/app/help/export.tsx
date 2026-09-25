import { useNavigation, useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { BrassWell, Glow, ScreenHeader, TopicRow } from '../../components/records/chrome';
import { networkFoot } from '../../components/records/copy';
import { Screen } from '../../components/Screen';
import { colors, fonts } from '../../components/theme';
import { finishHelpExport } from '../../lib/helpNavigation';

export default function HelpExportScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const cluster = process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER;
  return (
    <Screen>
      <Glow />
      <ScreenHeader title="Help" cluster={cluster} onBack={() => router.back()} />
      <BrassWell>
        <Text style={styles.kicker}>The record</Text>
        <Text style={styles.h1}>What the export proves</Text>
      </BrassWell>
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
      <TopicRow
        tone="paid"
        glyph="✓"
        title="Done"
        body="Leave help and return to where you were."
        accessibilityLabel="Done"
        onPress={() => finishHelpExport(router, navigation.getState()?.routes ?? null)}
      />
      <Text style={styles.foot}>{networkFoot()}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  h1: {
    color: colors.bone,
    fontFamily: fonts.serif,
    fontSize: 32,
    lineHeight: 36,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 24,
  },
  foot: {
    textAlign: 'center',
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
});
