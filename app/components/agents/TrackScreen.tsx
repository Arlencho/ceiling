import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { CatchMark } from '../backglass/CatchMark';
import { StatTile } from '../backglass/StatTile';
import { colors, fonts, radii, space } from '../theme';
import { networkBadge } from '../../lib/grade';
import { qrPngDataUri } from '../../lib/qrPng';
import { ruleEndedInsideCap } from '../../lib/plaques';
import { ruleCheckUrl, trackRecordFor, trackRecordPng, trackRecordText } from '../../lib/trackRecord';
import type { AgentScreenData } from './useAgentHistories';
import { BrassButton, Cabinet, CloseButton, GhostButton, NetworkPill, StatusLine } from './chrome';

export function TrackScreen({
  data,
  agent,
  onBack,
  onShareImage,
  onCopyLink,
  onSaveRecord,
}: {
  data: AgentScreenData;
  agent: string;
  onBack: () => void;
  onShareImage: (bytes: Uint8Array) => Promise<void>;
  onCopyLink: (url: string) => Promise<void>;
  onSaveRecord: (text: string) => Promise<void>;
}) {
  const record = data.agents.find((item) => item.agent === agent) ?? null;
  const missing = data.status === 'ready' && record == null;
  const [ruleAddress, setRuleAddress] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const rule = record?.rules.find((item) => item.address === ruleAddress) ?? record?.rules[0] ?? null;
  const ended = rule ? ruleEndedInsideCap(rule, data.nowSec) : false;
  const card = rule ? trackRecordFor(rule, record?.name ?? '', data.cluster, data.nowSec, ended) : null;
  const qr = card ? qrPngDataUri(card.qrText) : null;

  async function run(action: () => Promise<void>) {
    setShareError(null);
    try {
      await action();
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'The share did not finish.');
    }
  }

  return (
    <Cabinet refreshing={data.refreshing} onRefresh={data.refresh}>
      <View style={styles.header}>
        <CloseButton onPress={onBack} />
        <Text style={styles.headerTitle}>Track record</Text>
        <NetworkPill label={networkBadge(data.cluster, 'tokens')} />
      </View>
      {data.status === 'loading' ? <StatusLine>Reading the track record from the blockchain.</StatusLine> : null}
      {data.status === 'error' ? <StatusLine>{data.error ?? 'The record could not be read.'}</StatusLine> : null}
      {data.status === 'empty' || missing ? <StatusLine>This agent is not on a rule for this wallet.</StatusLine> : null}
      {record && card && rule && qr ? (
        <View style={styles.body}>
          <Text style={styles.kicker}>{card.kicker}</Text>
          <Text style={styles.h1}>{card.title}</Text>
          {record.rules.length > 1 ? (
            <View style={styles.picker}>
              {record.rules.map((item) => (
                <Pressable
                  key={item.address}
                  accessibilityRole="button"
                  accessibilityLabel={item.purpose}
                  accessibilityState={{ selected: item.address === rule.address }}
                  onPress={() => setRuleAddress(item.address)}
                >
                  <Text style={item.address === rule.address ? styles.picked : styles.pick}>{item.purpose}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View
            accessibilityLabel={`Shareable card. ${card.agentName}. ${card.lead} ${card.follow} ${card.badge}.`}
            style={styles.frame}
          >
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.brand}>
                  <CatchMark size={18} />
                  <Text style={styles.word}>Veto</Text>
                  <Text style={styles.cardKicker}>Track record</Text>
                </View>
                <NetworkPill label={card.badge} />
              </View>
              <Text style={styles.agent}>{card.agentName}</Text>
              <Text style={styles.range}>{card.rangeLine}</Text>
              <Text style={styles.lead}>
                {card.lead} {card.follow}
              </Text>
              <View style={styles.stats}>
                <StatTile value={String(card.paid)} label="payments paid, all within the rule" valueColor={colors.paid} />
                <StatTile value={String(card.refused)} label="payments refused, 0 moved" valueColor={colors.refused} />
                <StatTile value={String(card.allowances)} label="allowed by the owner after a refusal" />
                <StatTile
                  value={card.spentLabel}
                  suffix={`of ${card.capLabel}`}
                  label={card.ended ? `${card.remainingLabel} returned to the owner.` : `${card.remainingLabel} still available.`}
                />
              </View>
              <View style={styles.qrRow}>
                <Image
                  accessibilityRole="image"
                  accessibilityLabel="QR code of the rule address"
                  source={{ uri: qr.uri }}
                  style={styles.qr}
                />
                <View style={styles.qrCopy}>
                  <Text style={styles.qrTitle}>Check every line on the blockchain</Text>
                  <Text style={styles.qrMeta}>
                    Rule {card.shortAddress}. Payments, refusals with reasons, and the return are all public.
                  </Text>
                </View>
              </View>
            </View>
          </View>
          <BrassButton
            label="Share as an image"
            onPress={() => {
              void run(() => onShareImage(trackRecordPng(card)));
            }}
          />
          <View style={styles.pair}>
            <View style={styles.pairItem}>
            <GhostButton
              label="Copy the link"
              onPress={() => {
                void run(() => onCopyLink(ruleCheckUrl(card.ruleAddress, data.cluster, data.rpcUrl)));
              }}
            />
            </View>
            <View style={styles.pairItem}>
            <GhostButton
              label="Save the full record"
              onPress={() => {
                void run(() =>
                  onSaveRecord(trackRecordText(card, ruleCheckUrl(card.ruleAddress, data.cluster, data.rpcUrl))),
                );
              }}
            />
            </View>
          </View>
          {shareError ? <Text style={styles.error}>{shareError}</Text> : null}
          <Text style={styles.footer}>
            {
              "The card shows only what the blockchain holds. It shows the rule's address, not your name, and it says nothing about why the agent asked."
            }
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
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  body: { gap: 8, paddingHorizontal: space.screen, paddingTop: 8 },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  h1: { fontFamily: fonts.serifRegular, fontSize: 30, lineHeight: 33, color: colors.bone },
  picker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pick: { fontFamily: fonts.sans, fontSize: 13, color: colors.muted },
  picked: { fontFamily: fonts.sansBold, fontSize: 13, color: colors.brass },
  frame: {
    borderRadius: radii.frame,
    borderWidth: 2,
    borderColor: colors.brass,
    backgroundColor: colors.deepBrass,
  },
  card: {
    margin: 2,
    borderRadius: radii.frameInner,
    backgroundColor: colors.forestLift,
    padding: 16,
    gap: 12,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  word: { fontFamily: fonts.serif, fontSize: 16, color: colors.bone },
  cardKicker: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  agent: { fontFamily: fonts.serifRegular, fontSize: 26, lineHeight: 29, color: colors.bone },
  range: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted },
  lead: { fontFamily: fonts.serifRegular, fontSize: 21, lineHeight: 26, color: colors.bone },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  qrRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderTopColor: colors.boneLine, paddingTop: 10 },
  qr: { width: 56, height: 56, backgroundColor: colors.bone, borderRadius: 6 },
  qrCopy: { flex: 1, gap: 3 },
  qrTitle: { fontFamily: fonts.sansBold, fontSize: 13, color: colors.bone },
  qrMeta: { fontFamily: fonts.sans, fontSize: 11, lineHeight: 15, color: colors.muted },
  pair: { flexDirection: 'row', gap: 8 },
  pairItem: { flex: 1 },
  error: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.refused },
  footer: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, color: colors.muted },
});
