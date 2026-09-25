import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { LEARN_STEPS, SEED_VAULT_LINE } from '../../lib/onboarding';
import { SEEKER_APPROVAL_LINE } from '../../lib/wallet';
import { BrassFrame, MachineDiagram, StatTile, TiltStamp } from '../backglass';
import { colors, fonts, space, type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

const SAVE_ERROR = 'Could not save that choice on this phone.';

export function LearnStory({
  onSkip,
  onConnect,
  onConnectOther,
  connectBusy = false,
  showConnect,
  showOtherWallet = false,
  view = 'normal',
  error: errorOverride = null,
  cluster = null,
}: {
  onSkip: () => Promise<void> | void;
  onConnect: () => Promise<void> | void;
  onConnectOther?: () => Promise<void> | void;
  connectBusy?: boolean;
  showConnect: boolean;
  showOtherWallet?: boolean;
  view?: ScreenView;
  error?: string | null;
  cluster?: string | null;
}) {
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = LEARN_STEPS[step];
  const last = step === LEARN_STEPS.length - 1;
  const shownError = errorOverride ?? error;

  async function run(action: () => Promise<void> | void) {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await action();
    } catch {
      setPending(false);
      setError(SAVE_ERROR);
    }
  }

  if (!card || view === 'empty') {
    return (
      <FirstRunChrome
        stage="learn"
        cluster={cluster}
        view="empty"
        empty="The introduction has no steps to show."
      />
    );
  }

  const label = `Introduction, ${step + 1} of ${LEARN_STEPS.length}. ${card.name}. ${card.title} ${card.body}`;

  return (
    <FirstRunChrome
      stage="learn"
      cluster={cluster}
      view={view}
      error={shownError}
      footer={
        <>
          {last && showConnect ? (
            <>
              <Text style={styles.seeker}>{SEEKER_APPROVAL_LINE}</Text>
              <BrassButton
                label={connectBusy || pending ? 'Connecting...' : 'Connect wallet'}
                accessibilityLabel="Connect wallet"
                busy={connectBusy || pending}
                onPress={() => {
                  void run(onConnect);
                }}
              />
              {showOtherWallet && onConnectOther ? (
                <QuietButton
                  label="Use another wallet"
                  busy={connectBusy || pending}
                  onPress={() => {
                    void run(onConnectOther);
                  }}
                />
              ) : null}
            </>
          ) : null}
          {last && !showConnect ? (
            <BrassButton
              label="Done"
              accessibilityLabel="Done with the introduction"
              busy={pending}
              onPress={() => {
                void run(onSkip);
              }}
            />
          ) : null}
          {!last && card.next ? (
            <BrassButton
              label={card.next}
              onPress={() => {
                setStep((current) => Math.min(current + 1, LEARN_STEPS.length - 1));
              }}
            />
          ) : null}
          {last && !showConnect ? null : (
            <QuietButton
              label="Skip to connect wallet"
              busy={pending}
              onPress={() => {
                void run(onSkip);
              }}
            />
          )}
          {step > 0 ? (
            <QuietButton
              label="Back"
              onPress={() => {
                setStep((current) => Math.max(0, current - 1));
              }}
            />
          ) : null}
        </>
      }
    >
      <BrassFrame chase accessibilityLabel={card.diagramLabel}>
        <MachineDiagram litStations={card.lit} accessibilityLabel={card.diagramLabel} />
        <View style={styles.legend}>
          <Text style={styles.legendLit}>Lit: this step</Text>
          <Text style={styles.legendCaption}>{card.caption}</Text>
        </View>
      </BrassFrame>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        accessibilityLiveRegion="polite"
        style={styles.copy}
      >
        <Text style={styles.kicker}>{card.kicker}</Text>
        <Text style={styles.name}>{card.name}</Text>
        <Text style={styles.title}>{card.title}</Text>
        <Text style={styles.body}>{card.body}</Text>
        {step === 0 ? <Text style={styles.body}>{SEED_VAULT_LINE}</Text> : null}
        {card.bullets.map((bullet) => (
          <Text key={bullet} style={styles.bullet}>{`✓  ${bullet}`}</Text>
        ))}
        {step === 1 ? <RuleLesson /> : null}
        {step === 2 ? <RefusalLesson /> : null}
        {step === 3 ? <DecideLesson /> : null}
      </View>
    </FirstRunChrome>
  );
}

function RuleLesson() {
  return (
    <View style={styles.stats}>
      <StatTile value="You choose" label="Only payee" />
      <StatTile value="You choose" label="Per payment" />
      <StatTile value="You choose" label="Total ever" />
      <StatTile value="You choose" label="Ends in" />
    </View>
  );
}

function RefusalLesson() {
  return (
    <View style={styles.stack}>
      <TiltStamp reason="The rule said no. Nothing moved." />
      <Text style={styles.section}>What the blockchain keeps</Text>
      <Text style={styles.body}>Agent asked: more than the rule allows.</Text>
      <Text style={styles.body}>Rule allows: the most per payment you set.</Text>
      <Text style={styles.body}>Money moved: nothing.</Text>
    </View>
  );
}

function DecideLesson() {
  return (
    <View style={styles.stack}>
      <Text style={styles.section}>Your phone buzzes</Text>
      <Text style={styles.body}>Let that one payment through. Only that one. The most per payment stays the same.</Text>
      <Text style={styles.body}>{`Stop the rule. Your agent's next request is refused.`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
  },
  legendLit: {
    ...typeScale.caption,
    color: colors.muted,
  },
  legendCaption: {
    ...typeScale.caption,
    flex: 1,
    textAlign: 'right',
  },
  copy: {
    gap: space.md,
  },
  kicker: {
    ...typeScale.kicker,
  },
  name: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  title: {
    ...typeScale.display,
  },
  body: {
    ...typeScale.body,
  },
  bullet: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.body,
  },
  seeker: {
    ...typeScale.body,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  stack: {
    gap: space.md,
  },
  section: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
});
