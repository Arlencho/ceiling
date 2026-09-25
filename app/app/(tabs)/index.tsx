import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { ContextBar } from '../../components/ContextBar';
import { DecisionRow } from '../../components/DecisionRow';
import { EmptyState } from '../../components/EmptyState';
import { OpenFirstRule } from '../../components/OpenFirstRule';
import { ReadState } from '../../components/ReadState';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { formatBaseUnits, isListedDecision, timeLeftParts, todaysAgentDecisions } from '../../lib/format';
import { NOTIFICATIONS_OFF_LINE } from '../../lib/notificationAsk';
import { displayPurpose, spendRatio } from '../../lib/ruleView';
import { useChain } from '../../lib/useChain';
import { useNotificationOffer } from '../../lib/useNotificationOffer';
import { useRefreshOnFocus } from '../../lib/useRefreshOnFocus';
import { truncateAddress } from '../../lib/wallet';

export default function OverviewScreen() {
  const chain = useChain();
  const router = useRouter();
  useRefreshOnFocus(chain.refresh);
  const notifications = useNotificationOffer(chain.mandate != null);
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const today = todaysAgentDecisions(chain.rows, chain.nowMs);
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const mandate = chain.mandate;
  const index =
    mandate != null ? chain.mandates.findIndex((row) => row.address === mandate.address) : -1;
  const ratio = mandate ? spendRatio(mandate.spent, mandate.cap) : 0;
  const left = mandate ? timeLeftParts(mandate.expiresAt, nowSec) : null;

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <TopBar />
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.error && chain.mandateStatus !== 'rate-limited' ? (
          <EmptyState>{chain.error}</EmptyState>
        ) : null}
        {chain.mandateStatus === 'empty' ? (
          <OpenFirstRule onOpen={() => router.push('/rule/new')} />
        ) : (
          <ReadState
            status={chain.mandateStatus}
            empty="No rule on chain for this owner yet. This screen reads real history only and never invents rows."
          />
        )}
        {chain.mandateStatus === 'present' && mandate ? (
          <View style={styles.block}>
            {notifications.show ? (
              <View style={styles.block}>
                <EmptyState>{NOTIFICATIONS_OFF_LINE}</EmptyState>
                <Button
                  label="Turn notifications on"
                  accessibilityLabel="Turn notifications on"
                  invert={false}
                  onPress={() => {
                    void notifications.turnOn();
                  }}
                />
              </View>
            ) : null}
            <ContextBar
              title={displayPurpose(mandate.purpose)}
              subtitle={`rule ${index + 1} of ${chain.mandates.length} · agent ${truncateAddress(mandate.agent)}`}
              onSwitch={() => router.push('/(tabs)/rules')}
            />

            <View style={styles.state}>
              <Text style={styles.eyebrow}>Spent under this rule</Text>
              <View style={styles.bigRow}>
                <Text style={styles.big}>{formatBaseUnits(mandate.spent, chain.decimals)}</Text>
                <Text style={styles.of}>
                  of <Text style={styles.ofCap}>{formatBaseUnits(mandate.cap, chain.decimals)}</Text>
                </Text>
              </View>
              <View style={styles.bar}>
                <View style={[styles.barFill, { width: `${Math.max(ratio * 100, mandate.spent > 0n ? 1 : 0)}%` }]} />
              </View>
              <View style={styles.barLabels}>
                <Text style={styles.tick}>0</Text>
                <Text style={styles.tick}>cap {formatBaseUnits(mandate.cap, chain.decimals)}</Text>
              </View>
            </View>

            <View style={styles.stats}>
              <View style={styles.stat}>
                <Text style={styles.statV}>{String(mandate.spendCount)}</Text>
                <Text style={styles.statK}>paid</Text>
              </View>
              <View style={[styles.stat, styles.statRefused]}>
                <Text style={[styles.statV, styles.statRefusedText]}>{String(mandate.refusalCount)}</Text>
                <Text style={[styles.statK, styles.statRefusedText]}>refused, recorded</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statV}>{left?.value ?? '0'}</Text>
                <Text style={styles.statK}>{left?.label ?? 'expired'}</Text>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.eyebrow}>Today</Text>
              <Text
                style={styles.link}
                onPress={() => router.push('/(tabs)/decisions')}
                accessibilityRole="link"
              >
                all decisions
              </Text>
            </View>
            {today.length === 0 ? (
              <EmptyState>
                No payments, refusals, or overrides on this rule today. This screen never invents
                rows.
              </EmptyState>
            ) : (
              today
                .filter((row) => isListedDecision(row.kind))
                .map((row, i) => (
                  <DecisionRow
                    key={`${row.nonce.toString()}-${row.kind}-${i}`}
                    row={row}
                    decimals={chain.decimals}
                    cluster={cluster}
                    rpcUrl={rpcUrl}
                    mandateAddress={mandate.address}
                    perTxMax={mandate.perTxMax}
                    variant="today"
                  />
                ))
            )}
          </View>
        ) : null}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 12,
    alignSelf: 'stretch',
  },
  state: {
    marginTop: 4,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  bigRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 8,
  },
  big: {
    color: colors.text,
    fontSize: 64,
    lineHeight: 64,
    fontFamily: fonts.serif,
    letterSpacing: -1.5,
  },
  of: {
    color: colors.muted,
    fontSize: 26,
    fontFamily: fonts.serif,
    marginLeft: 8,
  },
  ofCap: {
    color: colors.text,
  },
  bar: {
    height: 2,
    backgroundColor: colors.line,
    marginTop: 16,
  },
  barFill: {
    height: 2,
    backgroundColor: colors.text,
  },
  barLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  tick: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  stats: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: 8,
  },
  stat: {
    flex: 1,
    paddingVertical: 12,
    paddingLeft: 12,
    borderRightWidth: 1,
    borderRightColor: colors.line,
  },
  statRefused: {
    backgroundColor: colors.invert,
    marginTop: -1,
    paddingLeft: 12,
    borderRightWidth: 0,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  statV: {
    color: colors.text,
    fontSize: 34,
    fontFamily: fonts.serif,
    lineHeight: 36,
  },
  statK: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '500',
    color: colors.muted,
  },
  statRefusedText: {
    color: colors.invertText,
  },
  section: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  link: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
    textDecorationLine: 'underline',
  },
});
