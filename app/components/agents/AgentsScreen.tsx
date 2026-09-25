import { Pressable, StyleSheet, Text, View } from 'react-native';

import { StatTile } from '../backglass/StatTile';
import { colors, fonts, radii, space } from '../theme';
import { agentsHeading, liveRulesLabel, networkBadge, type AgentRecord } from '../../lib/grade';
import type { AgentScreenData } from './useAgentHistories';
import { Cabinet, Chevron, GradeFace, HelpMark, LiveRules, NetworkPill, StatusLine, Wordmark } from './chrome';

export function AgentsScreen({
  data,
  onOpenAgent,
  onHowGrades,
}: {
  data: AgentScreenData;
  onOpenAgent: (agent: string) => void;
  onHowGrades: () => void;
}) {
  return (
    <Cabinet refreshing={data.refreshing} onRefresh={data.refresh}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Wordmark />
          <NetworkPill label={networkBadge(data.cluster, 'name')} />
        </View>
        <View style={styles.headerRight}>
          <LiveRules count={data.liveRules} label={liveRulesLabel(data.liveRules)} />
          <HelpMark onPress={onHowGrades} />
        </View>
      </View>

      {data.status === 'loading' ? <StatusLine>Reading your agents from the blockchain.</StatusLine> : null}
      {data.status === 'error' ? <StatusLine>{data.error ?? 'The record could not be read.'}</StatusLine> : null}
      {data.status === 'empty' ? (
        <StatusLine>No agent is on a rule yet. A grade appears after a rule is opened.</StatusLine>
      ) : null}

      {data.status === 'ready' ? (
        <>
          <View style={styles.kickerRow}>
            <Text style={styles.kicker}>Your agents</Text>
            <Text style={styles.kickerMeta}>{agentsHeading(data.agents)}</Text>
          </View>
          <View style={styles.list}>
            {data.agents.map((agent) => (
              <AgentCard key={agent.agent} agent={agent} onPress={() => onOpenAgent(agent.agent)} />
            ))}
          </View>
        </>
      ) : null}

      {data.status === 'ready' || data.status === 'empty' ? (
        <Text style={styles.footer}>
          A grade describes behaviour, not safety.{' '}
          <Text style={styles.link} onPress={onHowGrades} accessibilityRole="link">
            See how grades work
          </Text>
        </Text>
      ) : null}
    </Cabinet>
  );
}

function AgentCard({ agent, onPress }: { agent: AgentRecord; onPress: () => void }) {
  const one = agent.rules.length === 1 ? agent.rules[0] : null;
  const days = agent.daysValue.split(' of ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open the full record of ${agent.name}. Grade: ${agent.grade.label}.`}
      onPress={onPress}
      style={styles.card}
    >
      <View style={styles.cardTop}>
        <Text style={styles.name}>{agent.name}</Text>
        <View style={styles.address}>
          <Text style={styles.addressText}>{agent.shortAddress}</Text>
          <Chevron />
        </View>
      </View>
      {one ? (
        <Text style={styles.under} numberOfLines={1}>
          Under your rule <Text style={styles.purpose}>{one.purpose}</Text>
        </Text>
      ) : (
        <Text style={styles.under}>{`Under ${agent.rules.length} of your rules`}</Text>
      )}
      <GradeFace grade={agent.grade} detail={agent.cardLine} compact />
      <View style={styles.stats}>
        <StatTile value={String(agent.grade.paid)} label="paid, inside its rule" valueColor={colors.paid} />
        <StatTile value={String(agent.grade.outside)} label="asked outside" valueColor={colors.refused} />
        <StatTile
          value={String(agent.grade.allowances)}
          label="allowed once by you"
          valueColor={agent.grade.allowances > 0 ? colors.amber : colors.bone}
        />
        <StatTile
          value={days[0] ?? agent.daysValue}
          suffix={days[1] ? `of ${days[1]}` : undefined}
          label={agent.daysCaption}
        />
      </View>
      {agent.spend ? (
        <View style={styles.spendRow}>
          <Text style={styles.spend}>
            Can still spend <Text style={styles.spendNum}>{agent.spend.remainingLabel}</Text> of your {agent.spend.capLabel}
          </Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.round(agent.spend.ratio * 100)}%` }]} />
          </View>
        </View>
      ) : (
        <Text style={styles.spend}>Open the record for what each rule can still spend.</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xxxl,
    paddingLeft: space.screen,
    paddingRight: space.xl,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: space.screen,
    paddingTop: space.xl,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  kickerMeta: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted, flexShrink: 1, textAlign: 'right' },
  list: { gap: 7, paddingHorizontal: space.screen, paddingTop: space.md },
  card: {
    gap: 5,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  name: { fontFamily: fonts.serifRegular, fontSize: 18, color: colors.bone, flexShrink: 1 },
  address: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addressText: { fontFamily: fonts.sans, fontSize: 11, color: colors.muted },
  under: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted },
  purpose: { fontFamily: fonts.serifItalic, color: colors.body },
  stats: { flexDirection: 'row', gap: 6 },
  spendRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  spend: { fontFamily: fonts.sans, fontSize: 12, color: colors.body, flexShrink: 1 },
  spendNum: { fontFamily: fonts.serifRegular, fontSize: 15, color: colors.bone },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.lampOff, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.brass },
  footer: {
    marginHorizontal: space.screen,
    marginTop: space.md,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  link: { fontFamily: fonts.sansBold, color: colors.brass },
});
