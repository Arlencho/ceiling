import { StyleSheet, Text, View } from 'react-native';

import { Plaque } from '../backglass/Plaque';
import { colors, fonts, space } from '../theme';
import { networkBadge } from '../../lib/grade';
import { plaqueShareText, plaquesForRule } from '../../lib/plaques';
import type { AgentScreenData } from './useAgentHistories';
import { BackButton, Cabinet, NetworkPill, StatusLine } from './chrome';

export function PlaquesScreen({
  data,
  agent,
  onBack,
  onSharePlaque,
}: {
  data: AgentScreenData;
  agent: string;
  onBack: () => void;
  onSharePlaque: (text: string) => void;
}) {
  const record = data.agents.find((item) => item.agent === agent) ?? null;
  const missing = data.status === 'ready' && record == null;
  const name = record?.name ?? 'This agent';
  return (
    <Cabinet refreshing={data.refreshing} onRefresh={data.refresh}>
      <View style={styles.header}>
        <BackButton label="Back to the rule" onPress={onBack} />
        <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
        <NetworkPill label={networkBadge(data.cluster, 'tokens')} />
      </View>
      {data.status === 'loading' ? <StatusLine>Reading plaques from the blockchain.</StatusLine> : null}
      {data.status === 'error' ? <StatusLine>{data.error ?? 'The record could not be read.'}</StatusLine> : null}
      {data.status === 'empty' || missing ? <StatusLine>This agent is not on a rule for this wallet.</StatusLine> : null}
      {record ? (
        <View style={styles.body}>
          <Text style={styles.kicker}>
            {record.rules.length === 1 ? `Plaques, ${record.rules[0]?.dayLabel ?? 'on this rule'}` : 'Plaques'}
          </Text>
          <Text style={styles.h1}>Engraved under this rule.</Text>
          <Text style={styles.bodyText}>
            Each plaque is a fact from the blockchain, written as a sentence. It stays yours after the rule ends, and
            nothing is lost if you do not open the app.
          </Text>
          {record.rules.map((rule) => (
            <View key={rule.address} style={styles.rule}>
              {record.rules.length > 1 ? <Text style={styles.purpose}>{rule.purpose}</Text> : null}
              {plaquesForRule(rule, data.nowSec).map((plaque) => (
                <Plaque
                  key={`${rule.address}-${plaque.id}`}
                  date={plaque.dateLabel}
                  title={plaque.title}
                  detail={plaque.detail}
                  earned={plaque.earned}
                  onShare={
                    plaque.earned
                      ? () => onSharePlaque(plaqueShareText(plaque, rule.address))
                      : undefined
                  }
                />
              ))}
            </View>
          ))}
          <Text style={styles.footer}>
            A plaque is not a prize. It is a line from the record, and anyone you share it with can check it on the
            blockchain.
          </Text>
        </View>
      ) : null}
    </Cabinet>
  );
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
    flex: 1,
    textAlign: 'center',
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  body: { gap: 10, paddingHorizontal: space.screen, paddingTop: 10 },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  h1: { fontFamily: fonts.serifRegular, fontSize: 34, lineHeight: 37, color: colors.bone },
  bodyText: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 21, color: colors.body },
  rule: { gap: 10 },
  purpose: { fontFamily: fonts.serifItalic, fontSize: 16, color: colors.body },
  footer: {
    textAlign: 'center',
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    paddingBottom: space.lg,
  },
});
