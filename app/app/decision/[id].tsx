import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { RefusalCard } from '../../components/RefusalCard';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { KIND_OVERRIDE, KIND_REFUSED } from '../../lib/constants';
import { findLedgerDecision, parseDecisionId } from '../../lib/exportRecord';
import { explorerTxUrl, formatBaseUnits, formatClock, formatUnix, isListedDecision } from '../../lib/format';
import { mayClaimAbsence } from '../../lib/mandateRead';
import {
  nonceSequence,
  overrideOfferForReason,
  overrideRowView,
  sequenceLine,
  type OverrideAssessment,
} from '../../lib/override';
import { displayPurpose } from '../../lib/ruleView';
import { useChain } from '../../lib/useChain';
import type { LedgerRow } from '../../lib/ring';
import { truncateAddress } from '../../lib/wallet';

function rowProbeKey(row: LedgerRow): string {
  return `${row.ts.toString()}:${row.kind}:${row.nonce.toString()}:${row.reason}:${row.suggestedOverride.toString()}`;
}

export default function DecisionDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ? decodeURIComponent(rawId) : '';
  const parsed = id ? parseDecisionId(id) : null;
  const chain = useChain();
  const probeOverride = chain.probeOverride;
  const grantOverride = chain.grantOverride;
  const router = useRouter();
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const row = findLedgerDecision(chain.rows, parsed, chain.mandate?.address);
  const mandate =
    parsed != null
      ? chain.mandates.find((item) => item.address === parsed.mandate) ??
        (chain.mandate?.address === parsed.mandate ? chain.mandate : null)
      : chain.mandate;
  const probeKey = row ? rowProbeKey(row) : '';
  const liveKey = mandate
    ? `${mandate.address}:${mandate.status}:${mandate.lastNonce.toString()}:${mandate.overrideNonce.toString()}:${mandate.spent.toString()}`
    : '';

  const [probed, setProbed] = useState<{ key: string; assessment: OverrideAssessment } | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ key: string; row: LedgerRow } | null>(null);

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const offer =
    row && row.kind === KIND_REFUSED
      ? overrideOfferForReason(row.reason, row.suggestedOverride)
      : null;
  const needsProbe = Boolean(row && mandate && offer?.offer);

  useEffect(() => {
    if (!row || !mandate || !offer?.offer) {
      return;
    }
    const key = `${probeKey}|${liveKey}`;
    let cancelled = false;
    void probeOverride(mandate.address, row)
      .then((next) => {
        if (!cancelled) {
          setProbed({ key, assessment: next });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProbed({
            key,
            assessment: {
              status: 'blocked',
              why: 'The chain could not be re-read for this rule. This screen will not offer an override from a stale row. Pull to retry.',
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [row, mandate, offer?.offer, probeKey, liveKey, probeOverride]);

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

  const onSign = async () => {
    if (!row || !mandate) {
      return;
    }
    setGrantError(null);
    setSigning(true);
    try {
      const result = await grantOverride(mandate.address, row);
      setConfirmed({ key: probeKey, row: result.row });
      setConfirmKey(null);
    } catch (err) {
      setGrantError(err instanceof Error ? err.message : 'Override failed');
    } finally {
      setSigning(false);
    }
  };

  const seq = row ? nonceSequence(chain.rows, row.nonce) : null;
  const seqText = seq ? sequenceLine(seq, chain.decimals) : null;
  const overrideView = row && row.kind === KIND_OVERRIDE ? overrideRowView(row, chain.decimals) : null;
  const confirming = confirmKey === probeKey;
  const confirmedRow = confirmed?.key === probeKey ? confirmed.row : null;

  let assessment: OverrideAssessment | { status: 'checking' } | null = null;
  if (row && row.kind === KIND_REFUSED) {
    if (offer && !offer.offer) {
      assessment = { status: 'none', why: offer.why };
    } else if (probed && probed.key === `${probeKey}|${liveKey}`) {
      assessment = probed.assessment;
    } else if (needsProbe) {
      assessment = { status: 'checking' };
    }
  }

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <TopBar back="Decisions" meta={mandate ? displayPurpose(mandate.purpose) : undefined} />
      <ConnectGate>
        {!mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={chain.mandateStatus}
            empty="This decision is not on the ring for the selected rule. The app does not invent one."
          />
        ) : !row || !isListedDecision(row.kind) ? (
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
            ) : row.kind === KIND_OVERRIDE && overrideView ? (
              <View style={styles.paid}>
                <Text style={styles.eyebrow}>
                  {formatUnix(row.ts)} · {formatClock(row.ts)}
                </Text>
                <Text style={styles.say}>
                  {overrideView.say} <Text style={styles.italic}>{overrideView.italic}</Text>
                </Text>
                <Text style={styles.body}>{overrideView.why}</Text>
              </View>
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

            {seqText ? (
              <View style={styles.sequence}>
                <Text style={styles.eyebrow}>The record of this nonce</Text>
                <Text style={styles.seqBody}>{seqText}</Text>
              </View>
            ) : null}

            {row.kind === KIND_REFUSED ? (
              <OverrideGrant
                assessment={assessment}
                confirming={confirming}
                signing={signing}
                error={grantError}
                confirmed={confirmedRow}
                decimals={chain.decimals}
                onOffer={() => {
                  setGrantError(null);
                  setConfirmKey(probeKey);
                }}
                onCancel={() => {
                  setConfirmKey(null);
                  setGrantError(null);
                }}
                onSign={() => {
                  void onSign();
                }}
              />
            ) : null}

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

function OverrideGrant({
  assessment,
  confirming,
  signing,
  error,
  confirmed,
  decimals,
  onOffer,
  onCancel,
  onSign,
}: {
  assessment: OverrideAssessment | { status: 'checking' } | null;
  confirming: boolean;
  signing: boolean;
  error: string | null;
  confirmed: LedgerRow | null;
  decimals: number;
  onOffer: () => void;
  onCancel: () => void;
  onSign: () => void;
}) {
  if (confirmed) {
    return (
      <View style={styles.grant}>
        <Text style={styles.eyebrow}>Read back from chain</Text>
        <Text style={styles.seqBody}>
          Override of {formatBaseUnits(confirmed.amount, decimals)} for nonce{' '}
          {confirmed.nonce.toString()} is on the ledger as a recorded decision. The agent can retry
          this nonce.
        </Text>
      </View>
    );
  }
  if (!assessment) {
    return null;
  }
  if (assessment.status === 'checking') {
    return (
      <View style={styles.grant}>
        <EmptyState>
          Checking this rule and nonce on chain before offering an override.
        </EmptyState>
      </View>
    );
  }
  if (assessment.status === 'none' || assessment.status === 'blocked' || assessment.status === 'already') {
    return (
      <View style={styles.grant}>
        <Text style={styles.eyebrow}>Override</Text>
        <Text style={styles.seqBody}>{assessment.why}</Text>
      </View>
    );
  }
  if (confirming) {
    return (
      <View style={styles.grant}>
        <Text style={styles.eyebrow}>What you are about to sign</Text>
        {assessment.commit.paragraphs.map((paragraph) => (
          <Text key={paragraph} style={styles.seqBody}>
            {paragraph}
          </Text>
        ))}
        <View style={styles.actions}>
          <Button
            label="Sign and record this override"
            accessibilityLabel="Sign and record this override"
            busy={signing}
            onPress={onSign}
          />
          <Button
            label="Cancel"
            invert={false}
            quiet
            disabled={signing}
            onPress={onCancel}
          />
        </View>
        {error ? <Text style={styles.seqBody}>{error}</Text> : null}
      </View>
    );
  }
  return (
    <View style={styles.grant}>
      <Text style={styles.eyebrow}>Override</Text>
      <Text style={styles.seqBody}>
        {assessment.commit.paragraphs[0]} The owner signs once. This is recorded as an override, not
        a settings change.
      </Text>
      <Button
        label="Grant this override"
        accessibilityLabel="Grant this override"
        onPress={onOffer}
      />
      {error ? <Text style={styles.seqBody}>{error}</Text> : null}
    </View>
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
  sequence: {
    gap: 6,
  },
  seqBody: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 21,
  },
  grant: {
    gap: 10,
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
