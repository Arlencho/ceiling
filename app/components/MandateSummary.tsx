import { StyleSheet, Text, View } from 'react-native';

import { formatStatusLabel, formatTimeLeft, formatUnix } from '../lib/format';
import { formatTokenAmount } from '../lib/tokens';
import type { MandateAccount } from '../lib/mandate';
import { mandateRemaining } from '../lib/mandate';
import { displayPurpose, stampedRulesetLine } from '../lib/ruleView';
import { truncateAddress } from '../lib/wallet';
import { colors, fonts, radii, space } from './theme';

export function MandateSummary({
  mandate,
  decimals,
  nowSec,
  heading,
}: {
  mandate: MandateAccount;
  decimals: number;
  nowSec: bigint;
  heading: string;
}) {
  const remaining = mandateRemaining(mandate);
  const stamp = stampedRulesetLine(mandate.purpose);
  return (
    <View accessibilityLabel={heading} style={styles.wrap}>
      <Text style={styles.heading}>{heading}</Text>
      <Row label="Status" value={formatStatusLabel(mandate.status)} />
      <Row label="Purpose" value={displayPurpose(mandate.purpose)} />
      {stamp ? <Row label="Ruleset stamp" value={stamp} /> : null}
      <Row label="Cap" value={formatTokenAmount(mandate.cap, decimals, mandate.mint)} />
      <Row label="Spent" value={formatTokenAmount(mandate.spent, decimals, mandate.mint)} />
      <Row label="Remaining" value={formatTokenAmount(remaining, decimals, mandate.mint)} />
      <Row label="Per payment" value={formatTokenAmount(mandate.perTxMax, decimals, mandate.mint)} />
      <Row label="Expires" value={formatUnix(mandate.expiresAt)} />
      <Row label="Time left" value={formatTimeLeft(mandate.expiresAt, nowSec)} />
      <Row label="Payee" value={truncateAddress(mandate.merchant)} />
      <Row label="Agent" value={truncateAddress(mandate.agent)} />
      <Row label="Rule" value={truncateAddress(mandate.address)} />
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text selectable style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 0,
    alignSelf: 'stretch',
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.xxl,
    paddingBottom: space.sm,
  },
  heading: {
    color: colors.bone,
    fontSize: 15,
    fontFamily: fonts.serif,
    marginTop: space.xl,
    marginBottom: space.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.xl,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  label: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: fonts.sansMedium,
  },
  value: {
    color: colors.bone,
    fontSize: 14,
    fontFamily: fonts.sansSemibold,
    flexShrink: 1,
    textAlign: 'right',
  },
});
