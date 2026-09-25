import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import { CatchMark } from '../backglass/CatchMark';
import { colors, fonts, radii, space } from '../theme';
import { GRADE_LABEL, GRADE_RULE, networkBadge, type GradeId } from '../../lib/grade';
import type { AgentScreenData } from './useAgentHistories';
import { BackButton, Cabinet, GhostButton, NetworkPill, StatusLine } from './chrome';

const ORDER: GradeId[] = ['stayed', 'tested', 'pushed', 'too-new'];

export function GradesScreen({ data, onBack }: { data: AgentScreenData; onBack: () => void }) {
  return (
    <Cabinet refreshing={data.refreshing} onRefresh={data.refresh}>
      <View style={styles.header}>
        <BackButton label="Back to your agents" onPress={onBack} />
        <View style={styles.titleRow}>
          <CatchMark size={16} />
          <Text style={styles.headerTitle}>How grades work</Text>
        </View>
        <NetworkPill label={networkBadge(data.cluster, 'name')} />
      </View>

      {data.status === 'loading' ? <StatusLine>Reading your agents from the blockchain.</StatusLine> : null}
      {data.status === 'error' ? <StatusLine>{data.error ?? 'The record could not be read.'}</StatusLine> : null}

      {data.status === 'ready' || data.status === 'empty' ? (
        <>
          {data.status === 'empty' ? (
            <StatusLine>No agent is on a rule yet. These are the grades. There is nothing to grade.</StatusLine>
          ) : null}
          <View style={styles.intro}>
            <Text style={styles.h1}>Four grades, plain rules.</Text>
            <Text style={styles.body}>
              A <Text style={styles.strong}>request</Text> is a payment your agent asked for: the rule either let it
              through or refused it. The grade is the share of requests that were outside the rule.
            </Text>
          </View>
          <View style={styles.grades}>
            {ORDER.map((id) => (
              <View key={id} style={[styles.grade, gradeStyle(id)]}>
                <View style={styles.head}>
                  <View style={[styles.lamp, lampStyle(id)]} />
                  <Text style={styles.gradeTitle}>{GRADE_LABEL[id]}</Text>
                </View>
                <Text style={styles.rule}>{GRADE_RULE[id]}</Text>
              </View>
            ))}
          </View>
          <View style={styles.facts}>
            <Text style={styles.factsTitle}>What counts, and what does not</Text>
            <Fact tone={colors.refused} mark="refused">
              <Text style={styles.strong}>Outside its rule</Text> means the rule refused it: over your limit, the wrong
              payee, or outside its dates. Each refusal is saved with its reason.
            </Fact>
            <Fact tone={colors.amber} mark="plus">
              <Text style={styles.strong}>A payment you allowed once</Text> still counts as asking outside: the rule
              refused it first. If you had to allow <Text style={styles.strong}>2 or more</Text>, the grade shows one
              step lower.
            </Fact>
            <Fact tone={colors.muted} mark="note">
              <Text style={styles.strong}>Not counted:</Text>
              {
                " the agent's own signed declines, and money moved outside the rule. That is always 0 because the rule makes it impossible, so it is no credit to the agent."
              }
            </Fact>
          </View>
          <Text style={styles.note}>
            {
              "Every count is a fact saved on the blockchain, and anyone with the rule's address can check it. A grade describes how the agent behaved at its limits. "
            }
            <Text style={styles.strong}>It is not a safety guarantee.</Text>
          </Text>
          <View style={styles.backWrap}>
            <GhostButton label="Back to your agents" onPress={onBack} />
          </View>
        </>
      ) : null}
    </Cabinet>
  );
}

function gradeStyle(id: GradeId) {
  if (id === 'stayed') return { borderColor: 'rgba(156, 201, 168, 0.65)' };
  if (id === 'tested') return { borderColor: 'rgba(201, 162, 77, 0.65)' };
  if (id === 'pushed') return { borderColor: 'rgba(228, 164, 142, 0.65)' };
  return { borderColor: 'rgba(237, 230, 214, 0.35)', borderStyle: 'dashed' as const };
}

function lampStyle(id: GradeId) {
  if (id === 'stayed') return { backgroundColor: colors.paid };
  if (id === 'tested') return { backgroundColor: colors.amber };
  if (id === 'pushed') return { backgroundColor: colors.refused };
  return { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.body };
}

function Fact({ children, tone, mark }: { children: ReactNode; tone: string; mark: 'refused' | 'plus' | 'note' }) {
  return (
    <View style={styles.fact}>
      <Svg width={16} height={16} viewBox="0 0 24 24">
        {mark === 'refused' ? (
          <>
            <Circle cx={12} cy={12} r={9} fill="none" stroke={tone} strokeWidth={2} />
            <Path d="M5.6 5.6l12.8 12.8" fill="none" stroke={tone} strokeWidth={2} />
          </>
        ) : null}
        {mark === 'plus' ? <Path d="M12 3v18M5 12h14" fill="none" stroke={tone} strokeWidth={2} strokeLinecap="round" /> : null}
        {mark === 'note' ? (
          <Path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" fill="none" stroke={tone} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
      </Svg>
      <Text style={styles.factText}>{children}</Text>
    </View>
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
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  intro: { gap: 6, paddingHorizontal: space.screen, paddingTop: 6 },
  h1: { fontFamily: fonts.serifRegular, fontSize: 26, lineHeight: 29, color: colors.bone },
  body: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, color: colors.body },
  strong: { fontFamily: fonts.sansBold, color: colors.bone },
  grades: { gap: 5, paddingHorizontal: space.screen, paddingTop: space.md },
  grade: {
    gap: 3,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radii.plaque,
    borderWidth: 1,
    backgroundColor: colors.forestLift,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lamp: { width: 10, height: 10, borderRadius: 5 },
  gradeTitle: { fontFamily: fonts.serifRegular, fontSize: 17, color: colors.bone, flexShrink: 1 },
  rule: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.body },
  facts: {
    marginHorizontal: space.screen,
    marginTop: 10,
    borderRadius: radii.plaque,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.12)',
    overflow: 'hidden',
  },
  factsTitle: {
    height: 26,
    paddingHorizontal: 14,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.muted,
    borderBottomWidth: 1,
    borderBottomColor: colors.boneLine,
    lineHeight: 26,
  },
  fact: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
  },
  factText: { flex: 1, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.body },
  note: {
    marginHorizontal: space.screen,
    marginTop: 10,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.body,
  },
  backWrap: { marginHorizontal: space.screen, marginTop: 10 },
});
