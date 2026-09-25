import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { AdvisoryDeclineDetail } from '../../components/AdvisoryDecline';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { AllowOnce } from '../../components/records/AllowOnce';
import { GhostButton, Glow, Rise, ScreenHeader, SealNote } from '../../components/records/chrome';
import { barSplit, decisionWhen, refusalBody, whyRefused } from '../../components/records/copy';
import { Screen } from '../../components/Screen';
import { colors, fonts, radii } from '../../components/theme';
import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OVERRIDE, KIND_REFUSED, REASON_OVER_PER_TX_MAX } from '../../lib/constants';
import { findLedgerDecision, parseDecisionId } from '../../lib/exportRecord';
import { useOverrideGrant } from '../../lib/useOverrideGrant';
import { explorerTxUrl, formatBaseUnits, formatClock, formatUnix, isListedDecision } from '../../lib/format';
import { mandateRemaining } from '../../lib/mandate';
import { mayClaimAbsence } from '../../lib/mandateRead';
import { paidDecisionBody } from '../../lib/notify';
import { nonceSequence, overrideRowView, sequenceLine } from '../../lib/override';
import { renderReason } from '../../lib/reasons';
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
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const row = findLedgerDecision(chain.rows, parsed, chain.mandate?.address);
  const mandate =
    parsed != null
      ? chain.mandates.find((item) => item.address === parsed.mandate) ??
        (chain.mandate?.address === parsed.mandate ? chain.mandate : null)
      : chain.mandate;
  const grant = useOverrideGrant({
    row,
    mandate,
    nowSec,
    probeOverride: chain.probeOverride,
    grantOverride: chain.grantOverride,
  });

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const wantedMandate = parsed?.mandate ?? null;
  const loadedAddress = chain.mandate?.address ?? null;
  const { loading, mandateStatus, mandates, selectMandate } = chain;
  const wantedIsLoaded = wantedMandate
    ? mandates.some((item) => item.address === wantedMandate)
    : false;
  const switching =
    wantedMandate != null &&
    loadedAddress !== wantedMandate &&
    (loading || wantedIsLoaded || mandateStatus === 'not-read');

  useEffect(() => {
    if (!wantedMandate || !wantedIsLoaded) {
      return;
    }
    if (loadedAddress === wantedMandate || loading) {
      return;
    }
    void selectMandate(wantedMandate);
  }, [wantedMandate, wantedIsLoaded, loadedAddress, loading, selectMandate]);

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

  const seq = row && row.kind !== KIND_ADVISORY_DECLINE ? nonceSequence(chain.rows, row.nonce) : null;
  const seqText = seq ? sequenceLine(seq, chain.decimals) : null;
  const overrideView = row && row.kind === KIND_OVERRIDE ? overrideRowView(row, chain.decimals) : null;
  const when = row ? decisionWhen(row.ts, chain.nowMs) : '';

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <Glow />
      <ScreenHeader
        title="Decision"
        cluster={cluster}
        backLabel="Decisions"
        onBack={() => router.back()}
        onHelp={() => router.push('/help')}
      />
      <ConnectGate>
        {switching || !mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={switching ? 'not-read' : chain.mandateStatus}
            empty="This decision is not on the ring for the selected rule. The app does not invent one."
          />
        ) : !row || !isListedDecision(row.kind) ? (
          <EmptyState>
            This decision is not on the ring for the selected rule. The app does not invent one.
          </EmptyState>
        ) : (
          <View style={styles.block}>
            {row.kind === KIND_ADVISORY_DECLINE ? (
              <AdvisoryDeclineDetail
                when={`${formatUnix(row.ts)} · ${formatClock(row.ts)}`}
                reason={row.reasonText}
                amount={formatBaseUnits(row.amount, chain.decimals)}
              />
            ) : row.kind === KIND_REFUSED ? (
              <Rise delayMs={80}>
                <RefusedBody
                  row={row}
                  decimals={chain.decimals}
                  perTxMax={mandate?.perTxMax}
                  when={when}
                />
              </Rise>
            ) : row.kind === KIND_OVERRIDE && overrideView ? (
              <Rise delayMs={80}>
                <View style={styles.stack}>
                  <StatusPill label="Allowed once" tone="allowed" when={when} />
                  <Text style={styles.headline}>Allowed once.</Text>
                  <Text style={styles.body}>
                    {overrideView.say} {overrideView.italic}. {overrideView.why}
                  </Text>
                </View>
              </Rise>
            ) : (
              <Rise delayMs={80}>
                <View style={styles.stack}>
                  <StatusPill label="Paid" tone="paid" when={when} />
                  <Text style={styles.headline}>Paid {formatBaseUnits(row.amount, chain.decimals)}.</Text>
                  <Text style={styles.body}>
                    {mandate
                      ? paidDecisionBody({
                          amount: row.amount,
                          decimals: chain.decimals,
                          perTxMax: mandate.perTxMax,
                          merchant: mandate.merchant,
                        })
                      : `${formatBaseUnits(row.amount, chain.decimals)}. The payee for this rule is the rule.`}
                  </Text>
                </View>
              </Rise>
            )}

            {seqText ? (
              <View style={styles.sequence}>
                <Text style={styles.kicker}>The record of this nonce</Text>
                <Text style={styles.body}>{seqText}</Text>
              </View>
            ) : null}

            <SealNote
              linkLabel="See it on the blockchain"
              onPress={onExplorer}
              linkDisabled={!row.signature}
            >
              Saved on the blockchain with the reason and the time. Anyone can check it.
            </SealNote>

            <View style={styles.proofs}>
              <Text style={styles.kicker}>Proof</Text>
              {row.kind === KIND_ADVISORY_DECLINE ? null : (
                <ProofRow
                  label="program"
                  value={chain.config?.programId ? truncateAddress(chain.config.programId) : 'from config'}
                />
              )}
              <ProofRow label="rule" value={mandate ? truncateAddress(mandate.address) : 'unknown'} />
              <ProofRow
                label="transaction"
                value={row.signature ? truncateAddress(row.signature) : 'not returned by this RPC'}
                ok={Boolean(row.signature)}
              />
              {row.slot != null ? <ProofRow label="slot" value={String(row.slot)} /> : null}
              {row.kind === KIND_ADVISORY_DECLINE ? null : (
                <ProofRow label="payee" value={mandate ? truncateAddress(mandate.merchant) : 'on the rule'} />
              )}
            </View>

            {row.kind === KIND_REFUSED ? (
              <AllowOnce
                view={grant}
                decimals={chain.decimals}
                submitHeld={chain.submitHeld}
                payee={truncateAddress(row.counterparty)}
                perTxMax={mandate?.perTxMax ?? 0n}
                remaining={mandate ? mandateRemaining(mandate) : 0n}
              />
            ) : null}

            {row.kind === KIND_ADVISORY_DECLINE ? null : (
              <GhostButton label="Share this decision" onPress={onShare} />
            )}
            <Text style={styles.foot}>Allowing signs in Seed Vault. Veto never sees your key.</Text>
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

function RefusedBody({
  row,
  decimals,
  perTxMax,
  when,
}: {
  row: NonNullable<ReturnType<typeof findLedgerDecision>>;
  decimals: number;
  perTxMax?: bigint;
  when: string;
}) {
  const asked = formatBaseUnits(row.amount, decimals);
  const limit = perTxMax != null ? formatBaseUnits(perTxMax, decimals) : null;
  const reason = renderReason(row.reason, row.suggestedOverride, decimals);
  const split = perTxMax != null ? barSplit(row.amount, perTxMax) : null;
  const needed =
    row.reason === REASON_OVER_PER_TX_MAX && row.suggestedOverride > 0n
      ? formatBaseUnits(row.suggestedOverride, decimals)
      : 'No override would have cleared this.';
  return (
    <View style={styles.stack}>
      <StatusPill label="Refused" tone="refused" when={when} />
      <Text style={styles.headline}>No money moved.</Text>
      <Text style={styles.body}>
        {refusalBody({
          amount: row.amount,
          decimals,
          perTxMax,
          reason: row.reason,
          suggestedOverride: row.suggestedOverride,
        })}
      </Text>
      <View style={styles.compare}>
        <View style={styles.compareTop}>
          <View style={styles.compareCol}>
            <Text style={styles.kicker}>Your agent asked</Text>
            <Text style={[styles.figure, { color: colors.refused }]}>{asked}</Text>
          </View>
          <View style={styles.compareColEnd}>
            <Text style={styles.kicker}>Your limit per payment</Text>
            <Text style={[styles.figure, { color: colors.brass }]}>{limit ?? 'on the rule'}</Text>
          </View>
        </View>
        {split ? <LimitTrack allowedPct={split.allowedPct} overPct={split.overPct} /> : null}
        <View style={styles.grid}>
          <Fact label="To payee" value={truncateAddress(row.counterparty)} />
          <Fact label="Money moved" value={formatBaseUnits(0n, decimals)} />
          <Fact
            label="Why it was refused"
            value={whyRefused({
              reason: row.reason,
              decimals,
              perTxMax,
              fallback: reason.text,
            })}
          />
          <Fact label="Needed to allow it" value={needed} />
        </View>
      </View>
    </View>
  );
}

function LimitTrack({ allowedPct, overPct }: { allowedPct: number; overPct: number }) {
  return (
    <View style={styles.trackWrap}>
      <View style={styles.track}>
        <View style={[styles.allowed, { width: `${allowedPct}%` }]} />
        {overPct > 0 ? <View style={[styles.over, { width: `${overPct}%` }]} /> : null}
      </View>
      <View style={[styles.marker, { left: `${allowedPct}%` }]} />
      <Text style={[styles.limitLabel, { left: `${allowedPct}%` }]}>LIMIT</Text>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function StatusPill({
  label,
  tone,
  when,
}: {
  label: string;
  tone: 'refused' | 'paid' | 'allowed';
  when: string;
}) {
  const color = tone === 'paid' ? colors.paid : tone === 'allowed' ? colors.amber : colors.refused;
  return (
    <View style={styles.statusRow}>
      <View style={[styles.pill, { borderColor: color, backgroundColor: `${color}22` }]}>
        <View style={[styles.pillDot, { backgroundColor: color }]} />
        <Text style={[styles.pillText, { color }]}>{label}</Text>
      </View>
      <Text style={styles.when}>{when}</Text>
    </View>
  );
}

function ProofRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <View style={styles.prow}>
      <Text style={styles.pk}>{label}</Text>
      <Text selectable style={styles.pv}>
        {ok ? `✓ ${value}` : value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 12,
    alignSelf: 'stretch',
  },
  stack: {
    gap: 8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pillText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  when: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
  },
  headline: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colors.bone,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
  },
  compare: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  compareTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  compareCol: {
    gap: 2,
    flex: 1,
  },
  compareColEnd: {
    gap: 2,
    flex: 1,
    alignItems: 'flex-end',
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  figure: {
    fontFamily: fonts.serifLight,
    fontSize: 36,
    lineHeight: 40,
  },
  trackWrap: {
    height: 30,
    justifyContent: 'center',
  },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(237, 230, 214, 0.10)',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  allowed: {
    height: '100%',
    backgroundColor: colors.brass,
  },
  over: {
    height: '100%',
    backgroundColor: colors.refused,
  },
  marker: {
    position: 'absolute',
    top: 4,
    width: 2,
    height: 24,
    marginLeft: -1,
    backgroundColor: colors.bone,
  },
  limitLabel: {
    position: 'absolute',
    top: -2,
    marginLeft: -18,
    width: 36,
    textAlign: 'center',
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.8,
    color: colors.bone,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
    paddingTop: 8,
  },
  fact: {
    width: '47%',
    gap: 2,
  },
  factLabel: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  factValue: {
    color: colors.bone,
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    lineHeight: 18,
  },
  sequence: {
    gap: 6,
  },
  proofs: {
    gap: 0,
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
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  pv: {
    flex: 1,
    color: colors.bone,
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
  },
  foot: {
    textAlign: 'center',
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
  },
});
