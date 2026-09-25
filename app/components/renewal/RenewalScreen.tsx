import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import {
  projectNextRule,
  type NextRuleDraft,
  type RenewalEditField,
  type RenewalView,
} from '../../lib/renewal';
import { motionAllowed, useReducedMotion } from '../backglass/motion';
import { colors, fonts, radii, space, touchTarget } from '../theme';
import { RenewalHeader, RenewalShell, StatusLine } from './shell';

const RADIUS = 26;
const CIRC = 2 * Math.PI * RADIUS;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const FIELDS: { key: RenewalEditField; label: string }[] = [
  { key: 'merchant', label: 'Pays only' },
  { key: 'perTxMax', label: 'Most per payment' },
  { key: 'cap', label: 'Total set aside' },
  { key: 'expiryDays', label: 'Runs for' },
  { key: 'purpose', label: 'Purpose' },
];

export function RenewalScreen({
  status,
  message,
  view,
  decimals,
  nowSec,
  cluster,
  refreshing,
  letEndNote,
  onClose,
  onRefresh,
  onSetup,
  onLetEnd,
}: {
  status: 'loading' | 'empty' | 'error' | 'ready';
  message: string | null;
  view: RenewalView | null;
  decimals: number;
  nowSec: bigint;
  cluster: string | null;
  refreshing?: boolean;
  letEndNote: string | null;
  onClose: () => void;
  onRefresh?: () => void;
  onSetup: (draft: NextRuleDraft) => void;
  onLetEnd: () => void;
}) {
  const [draft, setDraft] = useState<NextRuleDraft | null>(view?.baseline ?? null);
  const [editing, setEditing] = useState<RenewalEditField | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const projected = view && draft ? projectNextRule(view, draft, nowSec, decimals) : null;

  return (
    <RenewalShell refreshing={refreshing} onRefresh={onRefresh}>
      <RenewalHeader title="Rule ending soon" backLabel="Close" onBack={onClose} icon="close" cluster={cluster} />
      {status === 'loading' ? <StatusLine>Reading this rule from the blockchain.</StatusLine> : null}
      {status === 'error' ? (
        <StatusLine>{message ?? 'The rule could not be read.'}</StatusLine>
      ) : null}
      {status === 'empty' ? (
        <StatusLine>
          {message ??
            'This rule is not ending in the next seven days. If you do nothing when it does end, what is left goes back to your wallet.'}
        </StatusLine>
      ) : null}
      {status === 'ready' && view && draft && projected ? (
        <View style={styles.body}>
          <View style={styles.hero}>
            <DayRing day={view.day} total={view.total} endsIn={view.endsIn} />
            <View style={styles.heroCopy}>
              <Text style={styles.kicker}>{view.agentName}</Text>
              <Text style={styles.h1}>{view.headline}</Text>
              <Text style={styles.lede}>{view.ifNothing}</Text>
            </View>
          </View>

          <View
            accessibilityLabel="What happened under this rule so far"
            style={styles.frame}
          >
            <Text style={styles.frameKicker}>What happened under this rule so far</Text>
            <View style={styles.facts}>
              <Fact value={String(view.paidCount)} label="paid" tone="paid" />
              <Fact value={String(view.refusedCount)} label="refused" tone="refused" />
              <Fact value={view.spentText} label={`spent of ${view.capText}`} tone="bone" />
              <Fact value={view.leftText} label="left" tone="bone" />
            </View>
            <View style={styles.lines}>
              <Line k="Highest amount your agent asked" v={view.highestAskedText} warn />
              <Line k="Highest amount paid" v={view.highestPaidText} />
              <Line k="Allowed by you after a refusal" v={view.allowedText} />
            </View>
          </View>
          {view.recordNote ? <Text style={styles.note}>{view.recordNote}</Text> : null}

          <Text style={styles.section}>The next rule, filled in from this one</Text>
          <View style={styles.card}>
            {FIELDS.map((field) => {
              const shown =
                field.key === 'merchant'
                  ? projected.merchantShown
                  : field.key === 'expiryDays'
                    ? projected.runsFor
                    : field.key === 'purpose'
                      ? draft.purpose
                      : draft[field.key];
              const amountField = field.key === 'perTxMax' || field.key === 'cap';
              const valueText = amountField && view.token ? `${shown} ${view.token}` : shown;
              return (
                <View key={field.key}>
                  <View style={styles.row}>
                    <Text style={styles.rowK}>{field.label}</Text>
                    <Text style={[styles.rowV, field.key === 'purpose' && styles.purpose]}>{valueText}</Text>
                    <Pressable
                      accessibilityRole="link"
                      accessibilityLabel={`Change ${field.label}`}
                      onPress={() => setEditing((current) => (current === field.key ? null : field.key))}
                      style={styles.changeHit}
                    >
                      <Text style={styles.change}>Change</Text>
                    </Pressable>
                  </View>
                  {editing === field.key ? (
                    <TextInput
                      accessibilityLabel={field.label}
                      value={draft[field.key]}
                      onChangeText={(text) => {
                        setDraft((current) => (current ? { ...current, [field.key]: text } : current));
                        setLocalError(null);
                      }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline={field.key === 'purpose'}
                      keyboardType={field.key === 'merchant' || field.key === 'purpose' ? 'default' : 'decimal-pad'}
                      placeholderTextColor={colors.muted}
                      style={styles.input}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
          <Text style={styles.because}>{projected.because}</Text>
          {localError ? <Text style={styles.error}>{localError}</Text> : null}
          {letEndNote ? <Text style={styles.note}>{letEndNote}</Text> : null}

          <View style={styles.spacer} />
          <BrassButton
            label="Set up the next rule"
            onPress={() => {
              if (projected.error) {
                setLocalError(projected.error);
                return;
              }
              setLocalError(null);
              onSetup(draft);
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Let this one end. ${view.letEndDetail}`}
            onPress={onLetEnd}
            style={styles.ghost}
          >
            <Text style={styles.ghostTitle}>Let this one end</Text>
            <Text style={styles.ghostDetail}>{letEndNote ?? view.letEndDetail}</Text>
          </Pressable>
          <Text style={styles.footer}>
            The next rule starts only after you sign it on this phone. It gets its own account and its own record.
          </Text>
        </View>
      ) : null}
    </RenewalShell>
  );
}

function Fact({ value, label, tone }: { value: string; label: string; tone: 'paid' | 'refused' | 'bone' }) {
  const color = tone === 'paid' ? colors.paid : tone === 'refused' ? colors.refused : colors.bone;
  return (
    <View style={styles.fact}>
      <Text style={[styles.factN, { color }]}>{value}</Text>
      <Text style={styles.factL}>{label}</Text>
    </View>
  );
}

function Line({ k, v, warn = false }: { k: string; v: string; warn?: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineK}>{k}</Text>
      <Text style={[styles.lineV, warn && styles.lineWarn]}>{v}</Text>
    </View>
  );
}

function DayRing({ day, total, endsIn }: { day: number | null; total: number | null; endsIn: string }) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const progress = day != null && total != null && total > 0 ? Math.min(1, Math.max(0, day / total)) : 1;
  const end = CIRC * (1 - progress);
  const [offset] = useState(() => new Animated.Value(end));

  useEffect(() => {
    if (!motionOn) {
      offset.setValue(end);
      return;
    }
    offset.setValue(CIRC);
    const anim = Animated.timing(offset, {
      toValue: end,
      duration: 1200,
      delay: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [end, motionOn, offset]);

  const center = day != null ? String(day) : endsIn.split(' ')[0] ?? '';
  const caption = day != null && total != null ? `OF ${total}` : 'LEFT';

  return (
    <View
      accessibilityLabel={day != null && total != null ? `Day ${day} of ${total}` : `${endsIn} left`}
      style={styles.ring}
    >
      <Svg width={64} height={64} viewBox="0 0 64 64">
        <Circle cx={32} cy={32} r={RADIUS} fill="none" stroke="rgba(237, 230, 214, 0.12)" strokeWidth={6} />
        <AnimatedCircle
          cx={32}
          cy={32}
          r={RADIUS}
          fill="none"
          stroke={colors.brass}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${CIRC} ${CIRC}`}
          strokeDashoffset={motionOn ? offset : end}
          rotation={-90}
          origin="32, 32"
        />
      </Svg>
      <View pointerEvents="none" style={styles.ringCenter}>
        <Text style={styles.ringDay}>{center}</Text>
        <Text style={styles.ringOf}>{caption}</Text>
      </View>
    </View>
  );
}

function BrassButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.brass}>
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path
          d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"
          fill="none"
          stroke={colors.forest}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </Svg>
      <Text style={styles.brassText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: space.screen,
    paddingTop: space.md,
    gap: space.lg,
    flexGrow: 1,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxl,
  },
  heroCopy: {
    flex: 1,
    gap: 4,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  h1: {
    fontFamily: fonts.serifRegular,
    fontSize: 28,
    lineHeight: 31,
    color: colors.bone,
  },
  lede: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.body,
  },
  ring: {
    width: 64,
    height: 64,
  },
  ringCenter: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringDay: {
    fontFamily: fonts.serifRegular,
    fontSize: 20,
    lineHeight: 22,
    color: colors.bone,
  },
  ringOf: {
    fontFamily: fonts.sansBold,
    fontSize: 9,
    lineHeight: 11,
    letterSpacing: 1,
    color: colors.muted,
  },
  frame: {
    borderRadius: radii.frame,
    borderWidth: 2,
    borderColor: colors.brass,
    backgroundColor: colors.forestLift,
    paddingHorizontal: space.xxxl,
    paddingTop: space.xxl,
    paddingBottom: space.xl,
    gap: space.xl,
  },
  frameKicker: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  facts: {
    flexDirection: 'row',
    gap: space.md,
  },
  fact: {
    flex: 1,
    gap: 2,
  },
  factN: {
    fontFamily: fonts.serifRegular,
    fontSize: 24,
    lineHeight: 24,
  },
  factL: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 14,
    color: colors.muted,
  },
  lines: {
    gap: 6,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
  },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
  },
  lineK: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  lineV: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.bone,
  },
  lineWarn: {
    color: colors.refused,
  },
  section: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  card: {
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    minHeight: touchTarget,
    paddingHorizontal: space.xxl,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(237, 230, 214, 0.12)',
  },
  rowK: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  rowV: {
    flex: 1,
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.bone,
    textAlign: 'right',
  },
  purpose: {
    fontFamily: fonts.serifItalic,
    fontWeight: '400',
  },
  changeHit: {
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  change: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 16,
    color: colors.brass,
  },
  input: {
    marginHorizontal: space.xxl,
    marginBottom: space.md,
    minHeight: touchTarget,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.brassLine,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    color: colors.bone,
    fontFamily: fonts.sans,
    fontSize: 15,
  },
  because: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  note: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  error: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.refused,
  },
  spacer: {
    flexGrow: 1,
    minHeight: space.md,
  },
  brass: {
    height: 54,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  brassText: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 20,
    color: colors.forest,
  },
  ghost: {
    minHeight: 56,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xxxl,
    paddingVertical: space.md,
    gap: 2,
  },
  ghostTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  ghostDetail: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
    textAlign: 'center',
  },
  footer: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    textAlign: 'center',
    paddingBottom: space.xl,
  },
});
