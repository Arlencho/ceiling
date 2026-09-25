import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Plaque } from '../backglass/Plaque';
import { StatTile } from '../backglass/StatTile';
import { colors, fonts, radii, space } from '../theme';
import { networkBadge, type AgentRecord } from '../../lib/grade';
import { earnedPlaques, plaquesForRule } from '../../lib/plaques';
import type { AgentScreenData } from './useAgentHistories';
import { BackButton, BrassButton, Cabinet, NetworkPill, StatusLine } from './chrome';

export function AgentRecordScreen({
  data,
  agent,
  onBack,
  onHowGrades,
  onPlaques,
  onShareRecord,
  onWeek,
  onDecisions,
}: {
  data: AgentScreenData;
  agent: string;
  onBack: () => void;
  onHowGrades: () => void;
  onPlaques: () => void;
  onShareRecord: () => void;
  onWeek: () => void;
  onDecisions: (ruleAddress: string) => void;
}) {
  const record = data.agents.find((item) => item.agent === agent) ?? null;
  const missing = data.status === 'ready' && record == null;
  return (
    <Cabinet refreshing={data.refreshing} onRefresh={data.refresh}>
      <View style={styles.header}>
        <BackButton label="Back to your agents" onPress={onBack} />
        <Text style={styles.headerTitle}>Agent record</Text>
        <NetworkPill label={networkBadge(data.cluster, 'name')} />
      </View>
      {data.status === 'loading' ? (
        <StatusLine>{"Reading this agent's record from the blockchain."}</StatusLine>
      ) : null}
      {data.status === 'error' ? <StatusLine>{data.error ?? 'The record could not be read.'}</StatusLine> : null}
      {data.status === 'empty' || missing ? (
        <StatusLine>This agent is not on a rule for this wallet.</StatusLine>
      ) : null}
      {record ? (
        <RecordBody
          record={record}
          nowSec={data.nowSec}
          onHowGrades={onHowGrades}
          onPlaques={onPlaques}
          onShareRecord={onShareRecord}
          onWeek={onWeek}
          onDecisions={onDecisions}
        />
      ) : null}
    </Cabinet>
  );
}

function RecordBody({
  record,
  nowSec,
  onHowGrades,
  onPlaques,
  onShareRecord,
  onWeek,
  onDecisions,
}: {
  record: AgentRecord;
  nowSec: bigint;
  onHowGrades: () => void;
  onPlaques: () => void;
  onShareRecord: () => void;
  onWeek: () => void;
  onDecisions: (ruleAddress: string) => void;
}) {
  const one = record.rules.length === 1 ? record.rules[0] : null;
  const plaques = record.rules.flatMap((rule) => earnedPlaques(plaquesForRule(rule, nowSec)));
  const latest = plaques.slice(0, 2);
  const ruleLine = one
    ? `under your rule ${one.purpose}. ${one.dayLabel}. Can still spend ${one.remainingLabel} of your ${one.capLabel}.`
    : `under ${record.rules.length} of your rules.`;
  return (
    <View style={styles.body}>
      <Text style={styles.h1}>{record.name}</Text>
      <Text style={styles.sub}>
        <Text style={styles.mono}>{record.shortAddress}</Text>
        {`, ${ruleLine}`}
      </Text>
      <View style={[styles.grade, { borderColor: borderFor(record.grade.id) }]}>
        <View style={styles.gradeTop}>
          <Text style={styles.eyebrow}>Grade so far</Text>
          <Pressable accessibilityRole="link" accessibilityLabel="How grades work" onPress={onHowGrades}>
            <Text style={styles.link}>How grades work</Text>
          </Pressable>
        </View>
        <View style={styles.gradeTitleRow}>
          <View style={[styles.lamp, lampFor(record.grade.id)]} />
          <Text style={styles.gradeTitle}>{record.grade.label}</Text>
        </View>
        <Text style={styles.gradeLine}>{record.recordLine}</Text>
        <Text style={styles.disclaimer}>
          A grade describes how the agent behaved at its limits. It is not a safety guarantee.
        </Text>
      </View>
      <View style={styles.stats}>
        <StatTile value={String(record.grade.paid)} label="paid, inside its rule" valueColor={colors.paid} />
        <StatTile value={String(record.grade.outside)} label="asked outside" valueColor={colors.refused} />
        <StatTile value={String(record.grade.allowances)} label="allowed once by you" />
        <StatTile
          value={one ? one.spentLabel : String(record.rules.length)}
          suffix={one ? `of ${one.capLabel}` : undefined}
          label={one ? 'spent so far' : 'rules'}
        />
      </View>
      <View style={styles.panel}>
        <View style={styles.panelTop}>
          <Text style={styles.eyebrow}>{`Its last ${record.ticks.length} requests`}</Text>
          <Text style={styles.meta}>oldest to newest</Text>
        </View>
        <View accessibilityLabel={record.tickLabel} style={styles.ticks}>
          {record.ticks.map((tick, index) => (
            <View key={`${tick.ts}-${index}`} style={tick.kind === 'paid' ? styles.paidTick : styles.refusedTick} />
          ))}
        </View>
        <View style={styles.legend}>
          <Text style={styles.legendText}>{`Paid by your agent, ${record.grade.paid}`}</Text>
          <Text style={styles.legendText}>{`Refused, ${record.grade.outside}`}</Text>
          <Pressable accessibilityRole="link" accessibilityLabel="See each one" onPress={() => onDecisions(record.rules[0]?.address ?? '')}>
            <Text style={styles.link}>See each one</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.reasons}>
        <View style={styles.reasonHead}>
          <Text style={styles.eyebrow}>Why the rule refused</Text>
          <Text style={styles.eyebrow}>{`${record.grade.outside} times`}</Text>
        </View>
        {record.reasons.map((reason) => (
          <View key={`${reason.ruleAddress}-${reason.reason}`} style={styles.reasonRow}>
            <Text style={styles.reasonLabel}>{reason.label}</Text>
            <Text style={styles.reasonCount}>{reason.count}</Text>
          </View>
        ))}
        <View style={styles.reasonRow}>
          <Text style={styles.reasonMuted}>Allowed once by you after a refusal</Text>
          <Text style={styles.reasonMutedNum}>{record.grade.allowances}</Text>
        </View>
        <View style={styles.reasonRow}>
          <Text style={styles.reasonMuted}>Its own signed declines, not in the grade</Text>
          <Text style={styles.reasonMutedNum}>{record.grade.declines}</Text>
        </View>
      </View>
      {record.rules.length > 1 ? (
        <View style={styles.rules}>
          {record.rules.map((rule) => (
            <Pressable key={rule.address} accessibilityRole="button" accessibilityLabel={`${rule.purpose}. Can still spend ${rule.remainingLabel} of ${rule.capLabel}.`} onPress={() => onDecisions(rule.address)}>
              <Text style={styles.ruleLine}>
                {rule.purpose}. Can still spend {rule.remainingLabel} of {rule.capLabel}. {rule.dayLabel}.
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.plaqueHead}>
        <Text style={styles.eyebrow}>{`Plaques earned, ${plaques.length}. Latest two:`}</Text>
        <Pressable accessibilityRole="link" accessibilityLabel={`Open all ${plaques.length} plaques`} onPress={onPlaques}>
          <Text style={styles.link}>{`Open all ${plaques.length} plaques`}</Text>
        </Pressable>
      </View>
      {latest.map((plaque) => (
        <Plaque key={`${plaque.id}-${plaque.atSec}`} date={plaque.dateLabel} title={plaque.title} detail={plaque.detail} />
      ))}
      <Pressable accessibilityRole="link" accessibilityLabel="Week in review" onPress={onWeek}>
        <Text style={styles.link}>Week in review</Text>
      </Pressable>
      <BrassButton label="Share this record" onPress={onShareRecord} />
      <Text style={styles.center}>Anyone can check each line on the blockchain.</Text>
    </View>
  );
}

function borderFor(id: AgentRecord['grade']['id']): string {
  if (id === 'stayed') return 'rgba(156, 201, 168, 0.65)';
  if (id === 'tested') return 'rgba(201, 162, 77, 0.65)';
  if (id === 'pushed') return 'rgba(228, 164, 142, 0.65)';
  return 'rgba(237, 230, 214, 0.35)';
}

function lampFor(id: AgentRecord['grade']['id']) {
  if (id === 'stayed') return { backgroundColor: colors.paid };
  if (id === 'tested') return { backgroundColor: colors.amber };
  if (id === 'pushed') return { backgroundColor: colors.refused };
  return { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.body };
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
  },
  headerTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  body: { gap: 6, paddingHorizontal: space.screen, paddingTop: 4 },
  h1: { fontFamily: fonts.serifRegular, fontSize: 26, lineHeight: 29, color: colors.bone },
  sub: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.muted },
  mono: { fontVariant: ['tabular-nums'] },
  grade: {
    gap: 7,
    padding: 10,
    paddingHorizontal: 14,
    borderRadius: radii.card,
    borderWidth: 1,
    backgroundColor: colors.forestLift,
  },
  gradeTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  link: { fontFamily: fonts.sansBold, fontSize: 12, color: colors.brass },
  gradeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lamp: { width: 12, height: 12, borderRadius: 6 },
  gradeTitle: { fontFamily: fonts.serifRegular, fontSize: 22, lineHeight: 24, color: colors.bone, flexShrink: 1 },
  gradeLine: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.body },
  disclaimer: {
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
    paddingTop: 6,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 15,
    color: colors.muted,
  },
  stats: { flexDirection: 'row', gap: 6 },
  panel: {
    gap: 6,
    padding: 9,
    paddingHorizontal: 14,
    borderRadius: radii.plaque,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.12)',
  },
  panelTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  meta: { fontFamily: fonts.sans, fontSize: 11, color: colors.muted },
  ticks: { flexDirection: 'row', gap: 3, minHeight: 20 },
  paidTick: { flex: 1, height: 20, borderRadius: 3, backgroundColor: colors.paid },
  refusedTick: {
    flex: 1,
    height: 20,
    borderRadius: 3,
    backgroundColor: 'rgba(228, 164, 142, 0.22)',
    borderWidth: 1,
    borderColor: colors.refused,
  },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  legendText: { fontFamily: fonts.sans, fontSize: 11, color: colors.body },
  reasons: {
    borderRadius: radii.plaque,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.12)',
    overflow: 'hidden',
  },
  reasonHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 26,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.boneLine,
  },
  reasonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
  },
  reasonLabel: { flex: 1, fontFamily: fonts.sans, fontSize: 13, color: colors.bone },
  reasonCount: { fontFamily: fonts.serifRegular, fontSize: 18, color: colors.refused },
  reasonMuted: { flex: 1, fontFamily: fonts.sans, fontSize: 13, color: colors.body },
  reasonMutedNum: { fontFamily: fonts.serifRegular, fontSize: 18, color: colors.body },
  rules: { gap: 4 },
  ruleLine: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.body },
  plaqueHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  center: { textAlign: 'center', fontFamily: fonts.sans, fontSize: 11, lineHeight: 15, color: colors.muted },
});
