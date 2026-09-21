import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { RuleListItem } from '../../components/RuleListItem';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { PAYEE_NOT_IN_RULESET, PAYEE_PREFILL, RULESET_ENVELOPE } from '../../lib/ruleset';
import { TEMPLATES } from '../../lib/templates';
import { useChain } from '../../lib/useChain';
import { useRulesets } from '../../lib/useRulesets';
import { useWallet } from '../../lib/useWallet';

export default function RulesScreen() {
  const chain = useChain();
  const wallet = useWallet();
  const rulesets = useRulesets();
  const router = useRouter();
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const selected = chain.mandate?.address ?? null;
  const count = chain.mandates.length;

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const heading =
    count === 0
      ? 'No rules yet.'
      : count === 1
        ? 'One rule, one agent.'
        : `${count} rules, ${count} agents.`;

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <TopBar title="rules" meta={count > 0 ? `${count} rules` : undefined} />
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.error && chain.mandateStatus !== 'rate-limited' ? (
          <EmptyState>{chain.error}</EmptyState>
        ) : null}
        <ReadState
          status={chain.mandateStatus}
          empty="Nothing on chain for this owner yet. A template is an empty starting point. This screen does not invent a rule."
        />

        {chain.mandateStatus === 'present' || chain.mandateStatus === 'empty' ? (
          <View style={styles.block}>
            <Text style={styles.h2}>{heading}</Text>
            <EmptyState>
              Each rule has its own agent key and its own history. Pick one and Overview and Decisions
              are about it.
            </EmptyState>

            <View>
              {chain.mandates.map((row) => (
                <RuleListItem
                  key={row.address}
                  mandate={row}
                  decimals={chain.decimals}
                  nowSec={nowSec}
                  current={row.address === selected}
                  onPress={() => {
                    void chain.selectMandate(row.address);
                    router.push(`/rule/${row.address}`);
                  }}
                />
              ))}
            </View>

            <Text style={styles.eyebrow}>Start another rule from</Text>
            {TEMPLATES.map((template) => (
              <Pressable
                key={template.id}
                accessibilityRole="button"
                accessibilityLabel={template.title}
                onPress={() => router.push(`/rule/new?template=${template.id}`)}
                style={styles.tpl}
              >
                <View style={styles.tplText}>
                  <Text style={styles.tplName}>{template.title}</Text>
                  <Text style={styles.tplSum}>{template.summary}</Text>
                </View>
                <Text style={styles.use}>use</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Blank rule"
              onPress={() => router.push('/rule/new')}
              style={styles.tpl}
            >
              <View style={styles.tplText}>
                <Text style={styles.tplName}>Blank rule</Text>
                <Text style={styles.tplSum}>cap, per payment, expiry, payee, purpose</Text>
              </View>
              <Text style={styles.use}>write</Text>
            </Pressable>

            <Text style={styles.eyebrow}>Rulesets on this phone</Text>
            <EmptyState>
              {`${RULESET_ENVELOPE} ${PAYEE_NOT_IN_RULESET} ${PAYEE_PREFILL} Applying one to a new agent is one action. The ruleset itself is not on chain. Its name and version are written into the purpose, which is on chain and cannot change after the rule is opened.`}
            </EmptyState>
            {rulesets.rulesets.length === 0 ? (
              <EmptyState>No rulesets saved on this phone yet.</EmptyState>
            ) : (
              rulesets.rulesets.map((set) => (
                <Pressable
                  key={`${set.id}-v${set.version}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${set.name} version ${set.version}`}
                  onPress={() =>
                    router.push(`/rule/new?ruleset=${encodeURIComponent(set.id)}&version=${set.version}`)
                  }
                  style={styles.tpl}
                >
                  <View style={styles.tplText}>
                    <Text style={styles.tplName}>
                      {set.name} v{set.version}
                    </Text>
                    <Text style={styles.tplSum}>
                      {set.cap} total, {set.perTxMax} per payment, {set.expiryDays} days. Apply to a
                      new agent.
                    </Text>
                  </View>
                  <Text style={styles.use}>apply</Text>
                </Pressable>
              ))
            )}
            <Button
              label="Author a ruleset"
              accessibilityLabel="Author a ruleset"
              invert={false}
              onPress={() => router.push('/rule/new?ruleset=new')}
            />

            <Button
              label={wallet.busy ? 'Disconnecting...' : 'Disconnect'}
              accessibilityLabel="Disconnect"
              busy={wallet.busy}
              invert={false}
              quiet
              onPress={() => {
                void wallet.disconnect();
              }}
            />
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
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
    letterSpacing: -0.3,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
    marginTop: 8,
  },
  tpl: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  tplText: {
    flex: 1,
  },
  tplName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  tplSum: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '500',
    marginTop: 3,
  },
  use: {
    color: colors.body,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
});
