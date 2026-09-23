import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { copyAgentAddress } from '../../lib/agentAddress';
import { STATUS_REVOKED } from '../../lib/constants';
import { askAfterFirstRuleOpened } from '../../lib/decisionNotifyTask';
import { formatBaseUnits, formatTimeLeft } from '../../lib/format';
import { mayClaimAbsence } from '../../lib/mandateRead';
import { notActiveHint } from '../../lib/reasons';
import { displayPurpose, formatExpiryDate, ruleSentence, stampedRulesetLine } from '../../lib/ruleView';
import { PAYEE_NOT_IN_RULESET, stampAlignment, stampAlignmentLine } from '../../lib/ruleset';
import { useChain } from '../../lib/useChain';
import { useRulesets } from '../../lib/useRulesets';
import { truncateAddress } from '../../lib/wallet';

export default function RuleDetailScreen() {
  const { address } = useLocalSearchParams<{ address: string }>();
  const chain = useChain();
  const stored = useRulesets();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const mandate = chain.mandates.find((row) => row.address === address) ?? null;
  const index = mandate ? chain.mandates.findIndex((row) => row.address === mandate.address) : -1;
  const stamp = mandate ? stampedRulesetLine(mandate.purpose) : null;
  const alignment =
    mandate && stored.ready
      ? stampAlignment({
          purpose: mandate.purpose,
          cap: mandate.cap,
          perTxMax: mandate.perTxMax,
          decimals: chain.decimals,
          rulesets: stored.rulesets,
        })
      : null;
  const stampNote =
    stamp && alignment
      ? `${stamp} is written into the purpose on chain. The ruleset file itself is not on chain. ${stampAlignmentLine(alignment.alignment, alignment.version)}. The stamp claims the cap and per-payment maximum. ${PAYEE_NOT_IN_RULESET} A reader without this phone cannot check that match. These numbers cannot be edited afterwards.`
      : stamp
        ? `${stamp} is written into the purpose on chain. The ruleset file itself is not on chain. The stamp claims the cap and per-payment maximum. ${PAYEE_NOT_IN_RULESET} These numbers cannot be edited afterwards.`
        : null;

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const openedAddress = mandate?.address ?? null;
  useEffect(() => {
    if (!openedAddress) {
      return;
    }
    void askAfterFirstRuleOpened().catch(() => undefined);
  }, [openedAddress]);

  const onCopyAgent = async () => {
    if (!mandate) {
      return;
    }
    setFormError(null);
    setMessage(null);
    try {
      await copyAgentAddress(mandate.agent, async (value) => {
        await Clipboard.setStringAsync(value);
      });
      setMessage('Agent address copied.');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Copy failed');
    }
  };

  const onRevoke = async () => {
    setFormError(null);
    setMessage(null);
    try {
      const result = await chain.revoke(address);
      setMessage(
        `Status on chain is now ${result.mandate.status === STATUS_REVOKED ? 'revoked' : String(result.mandate.status)}. The SPL delegation is dropped. Nothing already paid changes. The decisions stay readable.`,
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Revoke failed');
    }
  };

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <TopBar
        back="Rules"
        meta={mandate ? `${index + 1} of ${chain.mandates.length}` : undefined}
      />
      <ConnectGate>
        {!mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={chain.mandateStatus}
            empty="This rule is not on chain for this owner. The app does not invent one."
          />
        ) : !mandate ? (
          <EmptyState>
            This rule is not on chain for this owner. The app does not invent one.
          </EmptyState>
        ) : (
          <View style={styles.block}>
            <Text style={styles.h2}>The rule</Text>
            <Text style={styles.sentence}>{ruleSentence(mandate, chain.decimals)}</Text>

            <View style={styles.defs}>
              <Def label="Purpose" value={displayPurpose(mandate.purpose)} />
              {stamp ? <Def label="Stamped in purpose" value={stamp} /> : null}
              <Def label="Total cap" value={formatBaseUnits(mandate.cap, chain.decimals)} />
              <Def label="Per payment, max" value={formatBaseUnits(mandate.perTxMax, chain.decimals)} />
              <Def label="Expires" value={formatExpiryDate(mandate.expiresAt)} />
              <Def label="Payee" value={truncateAddress(mandate.merchant)} />
              <Def
                label="Spent so far"
                value={`${formatBaseUnits(mandate.spent, chain.decimals)} of ${formatBaseUnits(mandate.cap, chain.decimals)}`}
              />
              <Def label="Time left" value={formatTimeLeft(mandate.expiresAt, nowSec)} />
              <Def
                label="Agent"
                value={mandate.agent}
                stacked
                action={
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy agent address"
                    onPress={() => {
                      void onCopyAgent();
                    }}
                    style={({ pressed }) => [styles.copyHit, pressed && styles.copyPressed]}
                  >
                    <Text style={styles.copy}>Copy</Text>
                  </Pressable>
                }
              />
            </View>

            <Text style={styles.keys}>
              <Text style={styles.bold}>Owner key</Text> lives in Seed Vault and is the only key that
              can change this rule.{'\n'}
              <Text style={styles.bold}>Agent key</Text>{' '}
              <Text style={styles.mono}>{truncateAddress(mandate.agent)}</Text> holds authority and no
              funds. It can pay inside the rule, and nothing else.
            </Text>
            {stampNote ? (
              <EmptyState>{stampNote}</EmptyState>
            ) : (
              <EmptyState>
                Limits are fixed once the rule is opened. They cannot be widened later.
              </EmptyState>
            )}

            <View style={styles.actions}>
              <Button
                label="Edit the rule"
                invert={false}
                onPress={() =>
                  router.push(
                    `/rule/new?from=${encodeURIComponent(mandate.address)}`,
                  )
                }
              />
              {mandate.status === STATUS_REVOKED ? (
                <EmptyState>
                  This rule is already revoked on chain. A second revoke is rejected by the program
                  and records nothing.
                </EmptyState>
              ) : (
                <Button
                  label="Revoke this rule"
                  quiet
                  invert={false}
                  busy={chain.loading}
                  onPress={() => {
                    void onRevoke();
                  }}
                />
              )}
            </View>
            <Text style={styles.note}>
              Revoking ends authority for the agent now and is recorded on chain. Nothing already paid
              changes. The decisions stay readable. {notActiveHint()}
            </Text>
            {message ? <Text style={styles.ok}>{message}</Text> : null}
            {formError ? <Text style={styles.ok}>{formError}</Text> : null}
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

function Def({
  label,
  value,
  action,
  stacked = false,
}: {
  label: string;
  value: string;
  action?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <View style={[styles.def, stacked && styles.defStacked]}>
      {stacked ? (
        <View style={styles.defHead}>
          <Text style={styles.defK}>{label}</Text>
          {action}
        </View>
      ) : (
        <>
          <Text style={styles.defK}>{label}</Text>
          {action}
        </>
      )}
      <Text selectable style={[styles.defV, stacked && styles.defVStacked]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 12,
    alignSelf: 'stretch',
  },
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  sentence: {
    color: colors.text,
    fontSize: 25,
    lineHeight: 30,
    fontFamily: fonts.serif,
    letterSpacing: -0.2,
  },
  defs: {
    marginTop: 4,
  },
  def: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  defK: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '500',
  },
  defV: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
    fontFamily: fonts.mono,
    flexShrink: 1,
    textAlign: 'right',
  },
  defStacked: {
    flexDirection: 'column',
    justifyContent: 'flex-start',
    gap: 6,
  },
  defHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  defVStacked: {
    textAlign: 'left',
  },
  copyHit: {
    minHeight: 44,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  copyPressed: {
    opacity: 0.7,
  },
  copy: {
    color: colors.body,
    fontSize: 15,
    fontWeight: '500',
  },
  keys: {
    color: colors.body,
    fontSize: 14,
    lineHeight: 20,
  },
  bold: {
    color: colors.text,
    fontWeight: '600',
  },
  mono: {
    fontFamily: fonts.mono,
    color: colors.text,
  },
  actions: {
    gap: 10,
  },
  note: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  ok: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
});
