import { PublicKey } from '@solana/web3.js';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { expiryFromDays } from '../lib/approval';
import { parseOptionalAgentAddress } from '../lib/agentAddress';
import { poolsForCluster, type KnownPool } from '../lib/pools';
import { takeAddressScan } from '../lib/scanHandoff';
import { applyTemplate, templateById } from '../lib/templates';
import { floorPhrase, validateTradeForm, DEFAULT_FLOOR_PERCENT } from '../lib/tradeForm';
import { useChain } from '../lib/useChain';
import { useWallet } from '../lib/useWallet';
import { AddressActions } from './AddressActions';
import { HoldToApprove } from './backglass/HoldToApprove';
import { ConnectGate } from './ConnectGate';
import { Field } from './Field';
import { RuleScreen } from './RuleScreen';
import { TopBar } from './TopBar';
import { colors, fonts, radii } from './theme';

export function TradeRuleForm({
  templateId,
  leading,
}: {
  templateId: string;
  leading?: ReactNode;
}) {
  const template = templateById(templateId);
  const start = template?.kind === 'trade' && template ? applyTemplate(template) : null;
  const chain = useChain();
  const wallet = useWallet();
  const router = useRouter();
  const pools = poolsForCluster(chain.config?.explorerCluster);
  const [poolId, setPoolId] = useState(start?.poolId && pools.some((pool) => pool.id === start.poolId) ? start.poolId : (pools[0]?.id ?? ''));
  const [agentText, setAgentText] = useState('');
  const [perTrade, setPerTrade] = useState(start?.perTxMax ?? '');
  const [perDay, setPerDay] = useState(start?.dailyLimit ?? '');
  const [total, setTotal] = useState(start?.cap ?? '');
  const [floorPercent, setFloorPercent] = useState(start?.floorPercent ?? String(DEFAULT_FLOOR_PERCENT));
  const [days, setDays] = useState(start?.expiryDays ?? '7');
  const [purpose, setPurpose] = useState(start?.purpose ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [openedAddress, setOpenedAddress] = useState<string | null>(null);
  const [holdReset, setHoldReset] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openedAt] = useState(() => Date.now());

  useFocusEffect(
    useCallback(() => {
      const agent = takeAddressScan('agent');
      if (agent) {
        setAgentText(agent);
      }
    }, []),
  );

  const pool = pools.find((row) => row.id === poolId) ?? null;
  const symbol = pool?.inputSymbol ?? '';
  const percent = /^\d+$/.test(floorPercent.trim()) ? Number.parseInt(floorPercent.trim(), 10) : null;
  const validation = validateTradeForm({
    agent: agentText,
    owner: wallet.ownerPublicKey,
    poolId,
    poolIds: pools.map((row) => row.id),
    perTrade,
    perDay,
    total,
    floorPercent,
    days,
    purpose,
    decimals: pool?.inputDecimals ?? 9,
  });
  const ready = validation.ok && !opening && !chain.submitHeld && !openedAddress;

  const onApprove = async () => {
    if (!validation.ok || opening || openedAddress || chain.submitHeld) {
      setFormError(validation.ok ? null : validation.message);
      setHoldReset((value) => value + 1);
      return;
    }
    setOpening(true);
    setFormError(null);
    try {
      const agent = parseOptionalAgentAddress({
        text: agentText,
        owner: wallet.ownerPublicKey,
        payee: PublicKey.default,
      });
      const result = await chain.openTrade({
        poolId: validation.value.poolId,
        cap: validation.value.cap,
        perTradeMax: validation.value.perTradeMax,
        dailyLimit: validation.value.dailyLimit,
        floorPercent: validation.value.floorPercent,
        expiresAt: expiryFromDays(validation.value.days, openedAt),
        purpose: validation.value.purpose,
        ...(agent ? { agent: new PublicKey(agent) } : {}),
      });
      setOpenedAddress(result.rule.address);
      router.replace(`/rule/${result.rule.address}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Open failed');
      setHoldReset((value) => value + 1);
    } finally {
      setOpening(false);
    }
  };

  return (
    <RuleScreen
      footer={
        <View>
          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <HoldToApprove
            label={wallet.busy || opening ? 'Waiting on Seed Vault...' : 'Hold to approve rule'}
            disabled={!ready || wallet.busy}
            resetKey={holdReset}
            onConfirm={() => {
              void onApprove();
            }}
          />
        </View>
      }
    >
      <TopBar back="Rules" center="New rule" />
      <ConnectGate>
        {leading}
        <Text style={styles.kicker}>Trade rule</Text>
        <Text style={styles.h2}>{template?.kind === 'trade' ? template.title : 'Trade rule'}</Text>
        <Text style={styles.body}>
          One signature creates the input account, sets the floor from the pool rate, and pins where the output goes.
        </Text>
        <Field
          label="Agent"
          value={agentText}
          onChangeText={setAgentText}
          placeholder="scan or paste the agent address"
          hint="Leave this empty only for a test. Opening then creates a key on this phone."
        />
        <AddressActions target="agent" onAddress={setAgentText} onInvalid={setFormError} />
        <Text style={styles.label}>Pool</Text>
        {pools.length === 0 ? (
          <Text style={styles.body}>No pool is listed for this network.</Text>
        ) : (
          pools.map((row) => (
            <PoolChoice key={row.id} pool={row} selected={row.id === poolId} onPress={() => setPoolId(row.id)} />
          ))
        )}
        <Field
          label={`Most per trade${symbol ? ` (${symbol})` : ''}`}
          value={perTrade}
          onChangeText={setPerTrade}
        />
        <Field label={`Per day${symbol ? ` (${symbol})` : ''}`} value={perDay} onChangeText={setPerDay} />
        <Field
          label={`Total set aside${symbol ? ` (${symbol})` : ''}`}
          value={total}
          onChangeText={setTotal}
        />
        <Field
          label="Floor, percent of today's rate"
          value={floorPercent}
          onChangeText={setFloorPercent}
          hint={percent != null && percent >= 1 && percent <= 100 ? floorPhrase(percent) : floorPhrase(DEFAULT_FLOOR_PERCENT)}
        />
        <Field label="How long, in days" value={days} onChangeText={setDays} />
        <Field label="Purpose" value={purpose} onChangeText={setPurpose} multiline />
        {!validation.ok ? <Text style={styles.body}>{validation.message}</Text> : null}
      </ConnectGate>
    </RuleScreen>
  );
}

function PoolChoice({
  pool,
  selected,
  onPress,
}: {
  pool: KnownPool;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${pool.pair}. ${pool.feeLine}`}
      onPress={onPress}
      style={[styles.pool, selected && styles.poolOn]}
    >
      <Text style={styles.poolTitle}>{pool.pair}</Text>
      <Text style={styles.body}>{pool.feeLine}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  h2: {
    fontFamily: fonts.serif,
    fontSize: 28,
    color: colors.text,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
  },
  label: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.text,
  },
  error: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.text,
    marginBottom: 8,
  },
  pool: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.row,
    padding: 12,
    gap: 4,
    backgroundColor: colors.surface,
  },
  poolOn: {
    borderColor: colors.forest,
  },
  poolTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.text,
  },
});
