import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, space } from '../theme';

export const FIRST_RUN_STAGES = [
  { id: 'learn', label: 'Learn' },
  { id: 'connect', label: 'Connect wallet' },
  { id: 'agent', label: 'Add your agent' },
  { id: 'approve', label: 'Approve the rule' },
  { id: 'live', label: 'Live' },
  { id: 'protect', label: 'Protect' },
] as const;

export type FirstRunStage = (typeof FIRST_RUN_STAGES)[number]['id'];

type ProgressStripProps = {
  current: FirstRunStage;
  done?: readonly FirstRunStage[];
};

export function ProgressStrip({ current, done = [] }: ProgressStripProps) {
  const doneSet = new Set(done);
  const index = Math.max(
    0,
    FIRST_RUN_STAGES.findIndex((stage) => stage.id === current),
  );
  const currentLabel = FIRST_RUN_STAGES[index]?.label ?? FIRST_RUN_STAGES[0].label;

  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={`Your setup: step ${index + 1} of ${FIRST_RUN_STAGES.length}, ${currentLabel}`}
      style={styles.row}
    >
      {FIRST_RUN_STAGES.map((stage) => {
        const isCurrent = stage.id === current;
        const isDone = doneSet.has(stage.id);
        const lit = isCurrent || isDone;
        const stageLabel = isCurrent
          ? `${stage.label}, current step`
          : isDone
            ? `${stage.label}, done`
            : `${stage.label}, not yet`;
        return (
          <View key={stage.id} accessibilityLabel={stageLabel} style={styles.stage}>
            <View
              testID={`stage-bar-${stage.id}`}
              style={[styles.bar, lit ? styles.barLit : styles.barDim, isCurrent && styles.barCurrent]}
            />
            <Text style={[styles.label, lit ? styles.labelLit : styles.labelDim]}>{stage.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
  },
  bar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
  },
  barLit: {
    backgroundColor: colors.brass,
  },
  barDim: {
    backgroundColor: colors.track,
  },
  barCurrent: {
    shadowColor: colors.brass,
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  label: {
    minHeight: 24,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0.6,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  labelLit: {
    fontFamily: fonts.sansBold,
    color: colors.bone,
  },
  labelDim: {
    fontFamily: fonts.sansSemibold,
    color: colors.muted,
  },
});
