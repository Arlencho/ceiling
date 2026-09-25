import { redactRpc } from '../../lib/rpcPrivacy';
import { useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { HoldToApprove } from '../backglass/HoldToApprove';
import { colors, fonts, radii, space, touchTarget } from '../theme';

const STEPS = ['Move money in', 'Set the rules', 'Guardian key', 'Live'] as const;

export function HoldTop({
  title,
  network,
  onBack,
  backLabel = 'Back',
}: {
  title: string;
  network: string;
  onBack: () => void;
  backLabel?: string;
}) {
  return (
    <View style={styles.top}>
      <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={styles.hit}>
        <Text style={styles.back}>{'\u2039'}</Text>
      </Pressable>
      <Text style={styles.kicker}>{title}</Text>
      <View style={styles.pill} accessibilityLabel={network}>
        <Text style={styles.pillText}>{network}</Text>
      </View>
    </View>
  );
}

export function HoldSteps({ current }: { current: 0 | 1 | 2 | 3 }) {
  const label = STEPS[current];
  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={`Vault setup: step ${current + 1} of 4, ${label}`}
      style={styles.steps}
    >
      {STEPS.map((step, index) => {
        const done = index < current;
        const now = index === current;
        return (
          <View key={step} style={styles.step} accessibilityLabel={now ? `${step}, current step` : step}>
            <View style={[styles.bar, (done || now) && styles.barOn, now && styles.barNow]} />
            <Text style={[styles.stepLabel, now ? styles.stepNow : styles.stepDim]}>{step}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function HoldSign({
  name,
  label,
  hint,
  disabled = false,
  onSign,
}: {
  name: string;
  label: string;
  hint: string;
  disabled?: boolean;
  onSign: () => Promise<void>;
}) {
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function run() {
    if (busy.current || disabled) {
      setResetKey((value) => value + 1);
      return;
    }
    busy.current = true;
    setError(null);
    try {
      await onSign();
    } catch (err) {
      setResetKey((value) => value + 1);
      setError(err instanceof Error ? redactRpc(err.message) : 'The signature did not finish.');
    } finally {
      busy.current = false;
    }
  }

  return (
    <View testID={`${name}-${resetKey}`} style={styles.sign}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <HoldToApprove
        label={label}
        hint={hint}
        disabled={disabled}
        resetKey={resetKey}
        onConfirm={() => {
          void run();
        }}
      />
    </View>
  );
}

export function HoldInput({
  label,
  value,
  onChangeText,
  hint,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function StatusBlock({
  status,
  error,
  empty,
  children,
}: {
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  empty?: string;
  children: ReactNode;
}) {
  if (status === 'loading') {
    return <Text style={styles.body}>Reading the blockchain.</Text>;
  }
  if (status === 'error') {
    return <Text style={styles.error}>{error ?? 'This could not be read.'}</Text>;
  }
  if (status === 'empty') {
    return <Text style={styles.body}>{empty ?? 'Nothing here yet.'}</Text>;
  }
  return <>{children}</>;
}

export function ReelValue({ value, label }: { value: string; label?: string }) {
  return (
    <View style={styles.reel} accessibilityLabel={label ?? value}>
      <Text style={styles.reelText}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchTarget,
  },
  hit: {
    width: touchTarget,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: {
    color: colors.bone,
    fontSize: 28,
    lineHeight: 32,
    fontFamily: fonts.sans,
  },
  kicker: {
    flex: 1,
    textAlign: 'center',
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  pill: {
    minWidth: touchTarget,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.5)',
    borderRadius: radii.pill,
    paddingHorizontal: space.md,
    paddingVertical: 3,
    alignItems: 'center',
  },
  pillText: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  steps: {
    flexDirection: 'row',
    gap: space.sm,
  },
  step: {
    flex: 1,
    alignItems: 'center',
    gap: space.sm,
  },
  bar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.track,
  },
  barOn: {
    backgroundColor: 'rgba(201, 162, 77, 0.55)',
  },
  barNow: {
    backgroundColor: colors.brass,
  },
  stepLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  stepNow: {
    color: colors.bone,
    fontFamily: fonts.sansBold,
  },
  stepDim: {
    color: colors.muted,
  },
  sign: {
    gap: space.md,
  },
  error: {
    color: colors.refused,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
  },
  field: {
    gap: space.sm,
  },
  fieldLabel: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  input: {
    minHeight: touchTarget,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.bone,
    fontFamily: fonts.sans,
    fontSize: 16,
    paddingHorizontal: space.xl,
  },
  hint: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
  },
  reel: {
    minWidth: 40,
    height: 48,
    paddingHorizontal: space.md,
    borderRadius: radii.reel,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.6)',
    backgroundColor: colors.reelWell,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reelText: {
    color: colors.amber,
    fontFamily: fonts.serifRegular,
    fontSize: 28,
    lineHeight: 32,
  },
});
