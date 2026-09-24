import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { AdvisoryDeclineDetail } from '../../components/AdvisoryDecline';
import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { RefusalCard } from '../../components/RefusalCard';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OVERRIDE, KIND_REFUSED } from '../../lib/constants';
import { findLedgerDecision, parseDecisionId } from '../../lib/exportRecord';
import { explorerTxUrl, formatBaseUnits, formatClock, formatUnix, isListedDecision } from '../../lib/format';
import { mayClaimAbsence } from '../../lib/mandateRead';
import { paidDecisionBody } from '../../lib/notify';
import { nonceSequence, overrideRowView, sequenceLine } from '../../lib/override';
import { displayPurpose } from '../../lib/ruleView';
import { useChain } from '../../lib/useChain';
import { useOverrideGrant, type OverrideGrantView } from '../../lib/useOverrideGrant';
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

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <TopBar back="Decisions" meta={mandate ? displayPurpose(mandate.purpose) : undefined} />
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
            )}

            {seqText ? (
              <View style={styles.sequence}>
                <Text style={styles.eyebrow}>The record of this nonce</Text>
                <Text style={styles.seqBody}>{seqText}</Text>
              </View>
            ) : null}

            {row.kind === KIND_REFUSED ? (
              <OverrideGrant view={grant} decimals={chain.decimals} />
            ) : null}

            <View style={styles.proofs}>
              <View style={styles.proofH}>
                <Text style={styles.eyebrow}>Proof</Text>
                <Text style={styles.hint}>anyone can check this against the chain</Text>
              </View>
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

            <View style={styles.actions}>
              {row.kind === KIND_ADVISORY_DECLINE ? null : (
                <Button
                  label="Share this decision"
                  accessibilityLabel="Share this decision"
                  onPress={onShare}
                />
              )}
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

function OverrideGrant({ view, decimals }: { view: OverrideGrantView; decimals: number }) {
  const { assessment, confirming, signing, error, confirmed, onOffer, onCancel, onSign } = view;
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
