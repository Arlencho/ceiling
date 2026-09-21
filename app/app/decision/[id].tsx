import { useLocalSearchParams, useRouter } from 'expo-router';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { RefusalCard } from '../../components/RefusalCard';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { KIND_PAID, KIND_REFUSED } from '../../lib/constants';
import { findLedgerDecision, parseDecisionId } from '../../lib/exportRecord';
import { explorerTxUrl, formatBaseUnits, formatClock, formatUnix } from '../../lib/format';
import { mayClaimAbsence } from '../../lib/mandateRead';
import { displayPurpose } from '../../lib/ruleView';
import { useChain } from '../../lib/useChain';
import { truncateAddress } from '../../lib/wallet';

export default function DecisionDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ? decodeURIComponent(rawId) : '';
  const parsed = id ? parseDecisionId(id) : null;
  const chain = useChain();
  const router = useRouter();
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const row = findLedgerDecision(chain.rows, parsed, chain.mandate?.address);
  const mandate =
    parsed != null
      ? chain.mandates.find((item) => item.address === parsed.mandate) ??
        (chain.mandate?.address === parsed.mandate ? chain.mandate : null)
      : chain.mandate;

  const onShare = () => {
    if (!parsed) {
      return;
    }
    router.push(`/share?id=${encodeURIComponent(id)}`);
  };

  const onExplorer = () => {
    if (!row?.signature) {
      return;
    }
    void Linking.openURL(explorerTxUrl(row.signature, cluster, rpcUrl));
  };

  return (
    <Screen>
      <TopBar back="Decisions" meta={mandate ? displayPurpose(mandate.purpose) : undefined} />
      <ConnectGate>
        {!mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={chain.mandateStatus}
            empty="This decision is not on the ring for the selected rule. The app does not invent one."
          />
        ) : !row || (row.kind !== KIND_PAID && row.kind !== KIND_REFUSED) ? (
          <EmptyState>
            This decision is not on the ring for the selected rule. The app does not invent one.
          </EmptyState>
        ) : (
          <View style={styles.block}>
            {row.kind === KIND_REFUSED ? (
              <RefusalCard
                row={row}
                decimals={chain.decimals}
                perTxMax={mandate?.perTxMax}
                proof={
                  row.signature
                    ? `transaction ${truncateAddress(row.signature, 4)}${row.slot != null ? ` · slot ${row.slot}` : ''}`
                    : undefined
                }
              />
            ) : (
              <View style={styles.paid}>
                <Text style={styles.eyebrow}>
                  {formatUnix(row.ts)} · {formatClock(row.ts)}
                </Text>
                <Text style={styles.say}>
                  Paid <Text style={styles.italic}>within rule</Text>
                </Text>
                <Text style={styles.body}>
                  {formatBaseUnits(row.amount, chain.decimals)}
                  {mandate
                    ? `, under ${formatBaseUnits(mandate.perTxMax, chain.decimals)} per payment.`
                    : '.'}{' '}
                  The payee for this rule is {mandate ? truncateAddress(mandate.merchant) : 'the rule'}.
                </Text>
              </View>
            )}

            <View style={styles.proofs}>
              <View style={styles.proofH}>
                <Text style={styles.eyebrow}>Proof</Text>
                <Text style={styles.hint}>anyone can check this against the chain</Text>
              </View>
              <ProofRow
                label="program"
                value={chain.config?.programId ? truncateAddress(chain.config.programId) : 'from config'}
              />
              <ProofRow label="rule" value={mandate ? truncateAddress(mandate.address) : 'unknown'} />
              <ProofRow
                label="transaction"
                value={row.signature ? truncateAddress(row.signature) : 'not returned by this RPC'}
                ok={Boolean(row.signature)}
              />
              {row.slot != null ? <ProofRow label="slot" value={String(row.slot)} /> : null}
              <ProofRow label="payee" value={mandate ? truncateAddress(mandate.merchant) : 'on the rule'} />
            </View>

            <View style={styles.actions}>
              <Button
                label="Share this decision"
                accessibilityLabel="Share this decision"
                onPress={onShare}
              />
              <Button
                label="Open in explorer"
                invert={false}
                quiet
                disabled={!row.signature}
                onPress={onExplorer}
              />
            </View>
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

function ProofRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <View style={styles.prow}>
      <Text style={styles.pk}>{label}</Text>
      <Text selectable style={styles.pv}>
        {ok ? `\u2713 ${value}` : value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 16,
    alignSelf: 'stretch',
  },
  paid: {
    gap: 8,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  say: {
    color: colors.text,
    fontSize: 34,
    fontFamily: fonts.serif,
    lineHeight: 36,
  },
  italic: {
    fontStyle: 'italic',
    color: colors.muted,
  },
  body: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 21,
  },
  proofs: {
    gap: 0,
  },
  proofH: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
    gap: 12,
  },
  hint: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
  },
  prow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  pk: {
    width: 96,
    color: colors.muted,
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  pv: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  actions: {
    gap: 10,
  },
});
