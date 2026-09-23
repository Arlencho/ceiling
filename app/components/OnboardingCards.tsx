import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  ONBOARDING_CARDS,
  SEED_VAULT_LINE,
} from '../lib/onboarding';
import { Button } from './Button';
import { colors, fonts } from './theme';

const SAVE_ERROR = 'Could not save that choice on this phone.';

export function OnboardingCards({
  onSkip,
  onConnect,
  connectBusy = false,
  showConnect,
}: {
  onSkip: () => Promise<void> | void;
  onConnect: () => Promise<void> | void;
  connectBusy?: boolean;
  showConnect: boolean;
}) {
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = ONBOARDING_CARDS[step];
  const last = step === ONBOARDING_CARDS.length - 1;
  const showDone = last && !showConnect;
  if (!card) {
    return null;
  }

  const label = last
    ? `Introduction, ${step + 1} of ${ONBOARDING_CARDS.length}. ${card.title}. ${card.body} ${SEED_VAULT_LINE}`
    : `Introduction, ${step + 1} of ${ONBOARDING_CARDS.length}. ${card.title}. ${card.body}`;

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

  return (
    <View style={styles.block}>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        accessibilityLiveRegion="polite"
        style={styles.card}
      >
        <Text style={styles.step}>{`${step + 1} of ${ONBOARDING_CARDS.length}`}</Text>
        <Text style={styles.title}>{card.title}</Text>
        <Text style={styles.body}>{card.body}</Text>
        {last ? <Text style={styles.body}>{SEED_VAULT_LINE}</Text> : null}
      </View>
      <View style={styles.actions}>
        {last && showConnect ? (
          <Button
            label={connectBusy || pending ? 'Connecting...' : 'Connect'}
            accessibilityLabel="Connect"
            busy={connectBusy || pending}
            onPress={() => {
              void run(onConnect);
            }}
          />
        ) : null}
        {showDone ? (
          <Button
            label="Done"
            accessibilityLabel="Done with the introduction"
            busy={pending}
            onPress={() => {
              void run(onSkip);
            }}
          />
        ) : null}
        {!last ? (
          <Button
            label="Next"
            accessibilityLabel="Next introduction card"
            onPress={() =>
              setStep((current) => Math.min(current + 1, ONBOARDING_CARDS.length - 1))
            }
          />
        ) : null}
        {showDone ? null : (
          <Button
            label="Skip"
            accessibilityLabel="Skip introduction"
            invert={false}
            quiet
            busy={pending}
            onPress={() => {
              void run(onSkip);
            }}
          />
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 16,
    alignSelf: 'stretch',
  },
  card: {
    gap: 8,
    alignSelf: 'stretch',
  },
  step: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  title: {
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
    gap: 10,
    alignSelf: 'stretch',
  },
  error: {
    color: colors.body,
    fontSize: 14,
    lineHeight: 20,
  },
});
