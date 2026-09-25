import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, space, type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

const STEPS = [
  ['You set the rule', 'Who your agent may pay, how much, and until when.'],
  ['Your agent asks', 'It sends a payment request. It cannot take.'],
  ['The program checks the rule', 'Every request, every time, against your limits.'],
  ['Pays or refuses', 'Inside the rule it pays. Outside it refuses, and no money moves.'],
  ['Saved on the blockchain', 'Each payment and each refusal, with the reason.'],
  ['Your phone tells you', 'A notice for every payment or refusal, if alerts are on.'],
] as const;

const NEVER = [
  'Move money without asking',
  'Pay anyone else',
  'Go over the limits',
  'Change the rule',
] as const;

export function HowVetoWorks({
  cluster,
  connected,
  busy = false,
  error = null,
  onConnect,
  onDone,
  onSkip,
  onBack,
  view = 'normal',
}: {
  cluster: string | null;
  connected: boolean;
  busy?: boolean;
  error?: string | null;
  onConnect: () => void;
  onDone: () => void;
  onSkip?: () => void;
  onBack?: () => void;
  view?: ScreenView;
}) {
  return (
    <FirstRunChrome
      stage="learn"
      cluster={cluster}
      title="How Veto works"
      onBack={onBack}
      view={view}
      error={error}
      empty="How Veto works is not available yet."
      footer={
        <>
          {connected ? (
            <BrassButton
              label="Done"
              accessibilityLabel="Done with the introduction"
              busy={busy}
              onPress={onDone}
            />
          ) : (
            <>
              <BrassButton
                label={busy ? 'Connecting...' : 'Connect wallet'}
                accessibilityLabel="Connect wallet"
                busy={busy}
                onPress={onConnect}
              />
              {onSkip ? <QuietButton label="Skip to connect wallet" onPress={onSkip} /> : null}
            </>
          )}
          <Text style={styles.again}>You can read this again any time under Help.</Text>
        </>
      }
    >
      <Text style={styles.title}>Your agent asks. The rule decides. You get told.</Text>
      <View style={styles.list}>
        {STEPS.map(([heading, detail]) => (
          <View key={heading} style={styles.row}>
            <Text style={styles.heading}>{heading}</Text>
            <Text style={styles.detail}>{detail}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.neverTitle}>What your agent can never do</Text>
      {NEVER.map((item) => (
        <Text key={item} style={styles.never}>{item}</Text>
      ))}
    </FirstRunChrome>
  );
}

const styles = StyleSheet.create({
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 26,
    lineHeight: 30,
    color: colors.bone,
  },
  list: {
    gap: space.xl,
  },
  row: {
    gap: 2,
  },
  heading: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 22,
    color: colors.bone,
  },
  detail: {
    ...typeScale.body,
  },
  neverTitle: {
    ...typeScale.kicker,
    marginTop: space.md,
  },
  never: {
    ...typeScale.body,
  },
  again: {
    ...typeScale.caption,
    textAlign: 'center',
  },
});
