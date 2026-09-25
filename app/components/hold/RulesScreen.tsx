import { Pressable, StyleSheet, Text, View } from 'react-native';

import { bigDoorTriggers, type HoldDays, waitChangeCopy } from '../../lib/hold';
import { colors, fonts, radii, space, touchTarget } from '../theme';
import { HoldSteps, HoldTop, ReelValue } from './chrome';

export function RulesScreen({
  network,
  amountLabel,
  tokenName,
  walletLabel,
  dailyLabel,
  days,
  onLower,
  onRaise,
  onDays,
  onBack,
  onNext,
}: {
  network: string;
  amountLabel: string;
  tokenName: string;
  walletLabel: string;
  dailyLabel: string;
  days: HoldDays;
  onLower: () => void;
  onRaise: () => void;
  onDays: (days: HoldDays) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const triggers = bigDoorTriggers(dailyLabel);
  return (
    <View style={styles.wrap}>
      <HoldTop title="New Hold vault" network={network} onBack={onBack} />
      <HoldSteps current={1} />
      <View style={styles.hero}>
        <Text style={styles.kicker}>Moving into your vault</Text>
        <Text style={styles.amount}>
          {amountLabel} <Text style={styles.unit}>{tokenName}</Text>
        </Text>
        <Text style={styles.hint}>
          from your wallet {walletLabel}. You can take it back out through the doors below at any time.
        </Text>
      </View>
      <View style={styles.everyday}>
        <View style={styles.everydayCopy}>
          <Text style={styles.fastKicker}>Everyday door</Text>
          <Text style={styles.hint}>Leaves at once. Your limit per day, to addresses you have paid before.</Text>
        </View>
        <ReelValue value={dailyLabel} label={`Everyday limit ${dailyLabel} per day`} />
        <Pressable accessibilityRole="button" accessibilityLabel="Lower the everyday limit" onPress={onLower} style={styles.step}>
          <Text style={styles.stepText}>-</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Raise the everyday limit" onPress={onRaise} style={styles.stepOn}>
          <Text style={styles.stepOnText}>+</Text>
        </Pressable>
      </View>
      <View style={styles.big}>
        <Text style={styles.slowKicker}>Big door</Text>
        <Text style={styles.hint}>Anything else waits this long. You can stop it any time while it waits.</Text>
        <View accessibilityRole="radiogroup" style={styles.days}>
          {([1, 2, 3] as const).map((choice) => {
            const on = choice === days;
            const word = choice === 1 ? 'day' : 'days';
            return (
              <Pressable
                key={choice}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${choice} ${word}`}
                onPress={() => onDays(choice)}
                style={[styles.day, on && styles.dayOn]}
              >
                <Text style={[styles.dayNum, on && styles.dayNumOn]}>{choice}</Text>
                <Text style={[styles.dayWord, on && styles.dayNumOn]}>{word}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>{waitChangeCopy(days)}</Text>
      </View>
      <View style={styles.triggers}>
        <Text style={styles.kicker}>What goes through the big door</Text>
        {triggers.map((line, index) => (
          <Text key={line} style={styles.trigger}>
            <Text style={styles.num}>{index + 1} </Text>
            {line}
          </Text>
        ))}
        <Text style={styles.hint}>A quarter is 25% of what your vault holds.</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next: choose a guardian key"
        onPress={onNext}
        style={styles.cta}
      >
        <Text style={styles.ctaText}>Next: choose a guardian key</Text>
      </Pressable>
      <Text style={styles.center}>
        You sign once with Seed Vault on this phone when the vault goes live. Your key never leaves the phone.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  hero: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: colors.surface,
    padding: space.xxxl,
    gap: space.xs,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  amount: {
    color: colors.bone,
    fontFamily: fonts.serifLight,
    fontSize: 40,
    lineHeight: 44,
  },
  unit: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.body,
  },
  hint: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
  },
  everyday: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: 'rgba(156, 201, 168, 0.45)',
    backgroundColor: colors.surface,
    padding: space.md,
  },
  everydayCopy: { flex: 1, gap: 2 },
  fastKicker: {
    color: colors.paid,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  big: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.brassSoft,
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.md,
  },
  slowKicker: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  days: { flexDirection: 'row', gap: space.md },
  day: {
    flex: 1,
    minHeight: 64,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayOn: {
    borderColor: colors.brass,
    backgroundColor: 'rgba(201, 162, 77, 0.12)',
  },
  dayNum: {
    color: colors.bone,
    fontFamily: fonts.serifRegular,
    fontSize: 26,
    lineHeight: 28,
  },
  dayNumOn: { color: colors.amber },
  dayWord: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  triggers: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.xs,
  },
  trigger: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  num: { color: colors.brass, fontFamily: fonts.sansBold },
  cta: {
    height: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { color: colors.forest, fontFamily: fonts.sansBold, fontSize: 17 },
  center: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  step: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.brassLine,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepOn: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radii.control,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { color: colors.brass, fontSize: 22 },
  stepOnText: { color: colors.forest, fontSize: 22 },
});
