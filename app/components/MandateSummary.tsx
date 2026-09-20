import { StyleSheet, Text, View } from 'react-native';

import { formatBaseUnits, formatStatusLabel, formatTimeLeft, formatUnix } from '../lib/format';
import type { MandateAccount } from '../lib/mandate';
import { mandateRemaining } from '../lib/mandate';
import { truncateAddress } from '../lib/wallet';
import { colors } from './theme';

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
  return (
    <View style={styles.card} accessibilityLabel={heading}>
      <Text style={styles.heading}>{heading}</Text>
      <Row label="Status" value={formatStatusLabel(mandate.status)} />
      <Row label="Purpose" value={mandate.purpose} />
      <Row label="Cap" value={formatBaseUnits(mandate.cap, decimals)} />
      <Row label="Spent" value={formatBaseUnits(mandate.spent, decimals)} />
      <Row label="Remaining" value={formatBaseUnits(remaining, decimals)} />
      <Row label="Per payment" value={formatBaseUnits(mandate.perTxMax, decimals)} />
      <Row label="Expires" value={formatUnix(mandate.expiresAt)} />
      <Row label="Time left" value={formatTimeLeft(mandate.expiresAt, nowSec)} />
      <Row label="Merchant" value={truncateAddress(mandate.merchant)} />
      <Row label="Mandate" value={truncateAddress(mandate.address)} />
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
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    gap: 10,
    alignSelf: 'stretch',
  },
  heading: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: {
    color: colors.muted,
    fontSize: 14,
  },
  value: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
});
