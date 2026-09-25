import { StyleSheet, Text, View } from 'react-native';

import { CatchMark } from '../backglass';
import { colors, fonts, radii, space, type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

export function AlertsScreen({
  cluster,
  explanation,
  statusLine,
  exampleLimit,
  error = null,
  busy = false,
  onTurnOn,
  onNotNow,
  view = 'normal',
}: {
  cluster: string | null;
  explanation: string | null;
  statusLine: string | null;
  exampleLimit: string | null;
  error?: string | null;
  busy?: boolean;
  onTurnOn: () => void;
  onNotNow: () => void;
  view?: ScreenView;
}) {
  const asked = exampleLimit
    ? `Refused: your agent asked for more than the limit of ${exampleLimit}.`
    : 'Refused: your agent asked for more than the limit.';
  return (
    <FirstRunChrome
      stage="live"
      cluster={cluster}
      view={view}
      error={error}
      empty="Open a rule first. Alerts tell you when that rule pays or refuses."
      footer={
        <>
          <BrassButton label={busy ? 'Asking...' : 'Turn on alerts'} busy={busy} onPress={onTurnOn} />
          <QuietButton label="Not now" onPress={onNotNow} />
          <Text style={styles.note}>Alerts only tell you what happened. They never move money.</Text>
        </>
      }
    >
      <Text style={styles.kicker}>Turn on alerts</Text>
      <Text style={styles.title}>Know the moment it happens.</Text>
      <Text style={styles.body}>
        Your phone tells you each time your agent is paid or refused. You never have to go and check.
      </Text>
      {explanation ? <Text style={styles.body}>{explanation}</Text> : null}
      {statusLine ? <Text style={styles.body}>{statusLine}</Text> : null}
      <View
        accessibilityRole="image"
        accessibilityLabel={`${asked} No money moved.`}
        style={styles.banner}
      >
        <CatchMark size={28} />
        <View style={styles.bannerCopy}>
          <Text style={styles.bannerApp}>Veto</Text>
          <Text style={styles.bannerTitle}>{asked}</Text>
          <Text style={styles.bannerBody}>No money moved.</Text>
        </View>
      </View>
      <Text style={styles.note}>Example of what an alert looks like</Text>
    </FirstRunChrome>
  );
}

const styles = StyleSheet.create({
  kicker: {
    ...typeScale.kicker,
    textAlign: 'center',
  },
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 34,
    lineHeight: 37,
    color: colors.bone,
    textAlign: 'center',
  },
  body: {
    ...typeScale.body,
    textAlign: 'center',
  },
  banner: {
    flexDirection: 'row',
    gap: space.xl,
    padding: space.xxl,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.brassSoft,
  },
  bannerCopy: {
    flex: 1,
    gap: 3,
  },
  bannerApp: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  bannerTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.bone,
  },
  bannerBody: {
    ...typeScale.caption,
    color: colors.body,
  },
  note: {
    ...typeScale.caption,
    textAlign: 'center',
  },
});
