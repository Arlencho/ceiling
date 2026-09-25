import { StyleSheet, Text, View } from 'react-native';

import { REASON_OVER_PER_TX_MAX } from '../lib/constants';
import { formatTokenAmount } from '../lib/tokens';
import { refusalWhyLine } from '../lib/reasons';
import type { LedgerRow } from '../lib/ring';
import { payeeLabel } from '../lib/wallet';
import { SealRow } from './backglass/SealRow';
import { TiltStamp } from './backglass/TiltStamp';
import { Button } from './Button';
import { colors, fonts, radii, space } from './theme';

export function RefusalCard({
  row,
  decimals,
  perTxMax,
  mint,
  compact = false,
  onShare,
  proof,
  payee,
}: {
  row: LedgerRow;
  decimals: number;
  perTxMax?: bigint;
  mint?: string | null;
  compact?: boolean;
  onShare?: () => void;
  proof?: string;
  payee?: string;
}) {
  const why = refusalWhyLine({
    reason: row.reason,
    amount: row.amount,
    suggestedOverride: row.suggestedOverride,
    decimals,
    perTxMax,
    mint,
  });
  const asked = formatTokenAmount(row.amount, decimals, mint);
  const limit = perTxMax != null ? formatTokenAmount(perTxMax, decimals, mint) : null;
  const offer =
    row.reason === REASON_OVER_PER_TX_MAX && row.suggestedOverride > 0n
      ? formatTokenAmount(row.suggestedOverride, decimals, mint)
      : null;
  const split = perTxMax != null && perTxMax > 0n && row.amount > 0n ? barSplit(row.amount, perTxMax) : null;
  const tilt =
    row.reason === REASON_OVER_PER_TX_MAX ? 'Refused: over your limit' : why;

  if (compact) {
    return (
      <View style={styles.compact} accessibilityLabel="Refused, recorded on chain">
        <Text style={styles.compactTitle}>{limit ? `Refused: agent asked ${asked}, limit is ${limit}` : 'Refused'}</Text>
        <Text style={styles.compactWhy}>{why}</Text>
        {offer ? (
          <Text style={styles.offerLine}>
            <Text>allow this one payment of</Text>
          </Text>
        ) : null}
        {offer ? <Text style={styles.offerAmount}>{offer}</Text> : null}
        {onShare ? (
          <Button
            label="Share this decision"
            accessibilityLabel="Share this decision"
            onPress={onShare}
            onBone
          />
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.card} accessibilityLabel="Refused, recorded on chain">
      <TiltStamp reason={tilt} />
      <Text style={styles.say}>Nothing moved.</Text>
      <Text style={styles.why}>
        {limit
          ? `Your agent asked to pay ${asked}. Your rule allows at most ${limit} per payment. Veto refused it, so nothing left your account.`
          : why}
      </Text>
      <View style={styles.compare}>
        <View style={styles.compareHead}>
          <View>
            <Text style={styles.kicker}>Agent asked</Text>
            <Text style={styles.asked}>{asked}</Text>
          </View>
          {limit ? (
            <View style={styles.limitCol}>
              <Text style={styles.kicker}>Most per payment</Text>
              <Text style={styles.limit}>{limit}</Text>
            </View>
          ) : null}
        </View>
        {split ? (
          <View style={styles.track}>
            <View style={[styles.allowed, { width: `${split.allowed}%` }]} />
            {split.over > 0 ? <View style={[styles.over, { width: `${split.over}%` }]} /> : null}
          </View>
        ) : null}
        <View style={styles.facts}>
          <View style={styles.fact}>
            <Text style={styles.factK}>Payment to</Text>
            <Text style={styles.factV}>{payeeLabel(payee)}</Text>
          </View>
          <View style={styles.fact}>
            <Text style={styles.factK}>Money moved</Text>
            <Text style={styles.factV}>0</Text>
          </View>
          <View style={styles.factWide}>
            <Text style={styles.factK}>Reason saved on the blockchain</Text>
            <Text style={styles.factV}>{why}</Text>
          </View>
        </View>
      </View>
      {offer ? (
        <View style={styles.offer}>
          <Text style={styles.offerK}>Allow this one payment</Text>
          <Text>allow this one payment of</Text>
          <Text style={styles.offerAmount}>{offer}</Text>
          <Text style={styles.offerHint}>
            {limit
              ? `Only this payment. Limit stays ${limit}. The total cap does not change.`
              : 'Only this payment. The total cap does not change.'}
          </Text>
        </View>
      ) : null}
      <SealRow
        text="This refusal is saved on the blockchain with its reason. Anyone can check it."
        linkLabel="See it"
        onPress={onShare}
      />
      {proof ? <Text style={styles.proof}>{proof}</Text> : null}
      {onShare ? (
        <Button label="Share this decision" accessibilityLabel="Share this decision" onPress={onShare} onBone />
      ) : null}
    </View>
  );
}

function barSplit(asked: bigint, limit: bigint): { allowed: number; over: number } {
  if (asked <= limit) {
    return { allowed: 100, over: 0 };
  }
  const allowed = Number((limit * 1000n) / asked) / 10;
  const clamped = Math.min(100, Math.max(0, allowed));
  return { allowed: clamped, over: Math.max(0, 100 - clamped) };
}

const styles = StyleSheet.create({
  card: {
    gap: space.xxxl,
    alignSelf: 'stretch',
  },
  say: {
    fontFamily: fonts.serifRegular,
    fontSize: 40,
    lineHeight: 44,
    color: colors.bone,
    textAlign: 'center',
  },
  why: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
    textAlign: 'center',
  },
  compare: {
    gap: space.xl,
    padding: space.xxxl,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  compareHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  limitCol: {
    alignItems: 'flex-end',
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  asked: {
    fontFamily: fonts.serifLight,
    fontSize: 48,
    lineHeight: 50,
    color: colors.refused,
  },
  limit: {
    fontFamily: fonts.serifLight,
    fontSize: 48,
    lineHeight: 50,
    color: colors.brass,
  },
  track: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(237, 230, 214, 0.10)',
  },
  allowed: {
    height: '100%',
    backgroundColor: colors.brass,
  },
  over: {
    height: '100%',
    backgroundColor: colors.refused,
  },
  facts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  fact: {
    width: '46%',
    gap: 2,
  },
  factWide: {
    width: '100%',
    gap: 2,
  },
  factK: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
  },
  factV: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.bone,
  },
  offer: {
    gap: space.xs,
    padding: space.xxl,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  offerK: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 20,
    color: colors.bone,
  },
  offerLine: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  offerAmount: {
    fontFamily: fonts.serif,
    fontSize: 32,
    lineHeight: 34,
    color: colors.brass,
  },
  offerHint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  proof: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  compact: {
    gap: space.sm,
    alignSelf: 'stretch',
    padding: space.xl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  compactTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.bone,
  },
  compactWhy: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
  },
});
