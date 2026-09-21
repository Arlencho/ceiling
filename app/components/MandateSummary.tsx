import { StyleSheet, Text, View } from 'react-native';

import { formatBaseUnits, formatStatusLabel, formatTimeLeft, formatUnix } from '../lib/format';
import type { MandateAccount } from '../lib/mandate';
import { mandateRemaining } from '../lib/mandate';
import { displayPurpose, stampedRulesetLine } from '../lib/ruleView';
import { truncateAddress } from '../lib/wallet';
import { colors, fonts } from './theme';

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
      <Row label="Cap" value={formatBaseUnits(mandate.cap, decimals)} />
      <Row label="Spent" value={formatBaseUnits(mandate.spent, decimals)} />
      <Row label="Remaining" value={formatBaseUnits(remaining, decimals)} />
      <Row label="Per payment" value={formatBaseUnits(mandate.perTxMax, decimals)} />
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
  },
  heading: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 8,
    fontFamily: fonts.sans,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  label: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '500',
  },
  value: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
    textAlign: 'right',
    fontFamily: fonts.mono,
  },
});
