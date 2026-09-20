import { PublicKey } from '@solana/web3.js';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../components/Button';
import { ConnectGate } from '../components/ConnectGate';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { MandateSummary } from '../components/MandateSummary';
import { Screen } from '../components/Screen';
import { ScreenTitle, SectionTitle } from '../components/SectionTitle';
import { colors } from '../components/theme';
import { PURPOSE_MAX_LEN } from '../lib/constants';
import { parseBaseUnits } from '../lib/format';
import { mandateAbsenceCopy } from '../lib/mandateRead';
import { applyTemplate, TEMPLATES, type MandateFields } from '../lib/templates';
import { useChain } from '../lib/useChain';
import { useWallet } from '../lib/useWallet';

const BLANK: MandateFields = {
  cap: '',
  perTxMax: '',
  expiryDays: '',
  merchant: '',
  purpose: '',
};

export default function MandateScreen() {
  const chain = useChain();
  const wallet = useWallet();
  const [fields, setFields] = useState<MandateFields>(BLANK);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [committedAddress, setCommittedAddress] = useState<string | null>(null);
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const refresh = chain.refresh;
  const mayOpen = chain.mandateStatus === 'empty' || chain.mandateStatus === 'present';
  const absence = chain.configError
    ? null
    : mandateAbsenceCopy(
        chain.mandateStatus,
        'Nothing committed yet for this owner. This screen does not invent a mandate.',
      );

  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const setField = (key: keyof MandateFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const onSubmit = async () => {
    setFormError(null);
    try {
      if (!chain.config) {
        throw new Error(chain.configError ?? 'Config is missing');
      }
      const cap = parseBaseUnits(fields.cap, chain.decimals);
      const perTxMax = parseBaseUnits(fields.perTxMax, chain.decimals);
      const days = Number.parseInt(fields.expiryDays.trim(), 10);
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error('expiry must be a whole number of days from now');
      }
      if (fields.purpose.trim().length === 0) {
        throw new Error('purpose is required');
      }
      if (fields.purpose.trim().length > PURPOSE_MAX_LEN) {
        throw new Error(`purpose is longer than ${PURPOSE_MAX_LEN} characters`);
      }
      const merchant = new PublicKey(fields.merchant.trim());
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
      const result = await chain.open({
        merchant,
        cap,
        perTxMax,
        expiresAt,
        purpose: fields.purpose.trim(),
      });
      setCommittedAddress(result.mandate.address);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Open failed');
    }
  };

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <ScreenTitle>Mandate</ScreenTitle>
      <EmptyState>
        One Seed Vault signature opens the mandate and delegates the cap in the same transaction.
        Confirmation below is read back from chain, not from this form.
      </EmptyState>
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.error ? <Text style={styles.error}>{chain.error}</Text> : null}
        <SectionTitle>Starting templates</SectionTitle>
        <EmptyState>
          A template is an empty starting point. It never ships example transactions or prices.
        </EmptyState>
        <View style={styles.templates}>
          {TEMPLATES.map((template) => {
            const active = selectedTemplate === template.id;
            return (
              <Pressable
                key={template.id}
                accessibilityRole="button"
                accessibilityLabel={template.title}
                onPress={() => {
                  setSelectedTemplate(template.id);
                  setFields(applyTemplate(template));
                  setCommittedAddress(null);
                }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={active ? styles.chipActiveLabel : styles.chipLabel}>
                  {template.title}
                </Text>
                <Text style={styles.chipSummary}>{template.summary}</Text>
              </Pressable>
            );
          })}
        </View>
        <Field
          label="Cap"
          value={fields.cap}
          onChangeText={(text) => setField('cap', text)}
          placeholder="total, in tokens"
        />
        <Field
          label="Per-payment maximum"
          value={fields.perTxMax}
          onChangeText={(text) => setField('perTxMax', text)}
          placeholder="largest single payment"
        />
        <Field
          label="Expiry (days from now)"
          value={fields.expiryDays}
          onChangeText={(text) => setField('expiryDays', text)}
          placeholder="7"
        />
        <Field
          label="Merchant"
          value={fields.merchant}
          onChangeText={(text) => setField('merchant', text)}
          placeholder="merchant wallet"
        />
        <Field
          label="Purpose"
          value={fields.purpose}
          onChangeText={(text) => setField('purpose', text)}
          placeholder="in your own words"
          multiline
        />
        <Button
          label={wallet.busy ? 'Waiting on Seed Vault...' : 'Open mandate'}
          accessibilityLabel="Open mandate"
          busy={wallet.busy}
          disabled={!mayOpen}
          onPress={() => {
            void onSubmit();
          }}
        />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        {chain.mandateStatus === 'present' && chain.mandate ? (
          <MandateSummary
            heading={
              committedAddress
                ? 'Committed on chain (read back after the signature)'
                : 'Mandate already on chain (read from chain)'
            }
            mandate={chain.mandate}
            decimals={chain.decimals}
            nowSec={nowSec}
          />
        ) : absence ? (
          <EmptyState>{absence}</EmptyState>
        ) : null}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  templates: {
    gap: 10,
    alignSelf: 'stretch',
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  chipActive: {
    borderColor: colors.invert,
  },
  chipLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  chipActiveLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  chipSummary: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
