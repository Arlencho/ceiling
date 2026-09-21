import { PublicKey } from '@solana/web3.js';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { PURPOSE_MAX_LEN } from '../../lib/constants';
import { formatBaseUnits, parseBaseUnits } from '../../lib/format';
import type { MandateAccount } from '../../lib/mandate';
import { displayPurpose } from '../../lib/ruleView';
import {
  applyRuleset,
  assertPurposeMayOpen,
  rulesetSlug,
  stampPurpose,
  type Ruleset,
} from '../../lib/ruleset';
import { applyTemplate, TEMPLATES, type MandateFields } from '../../lib/templates';
import { useChain } from '../../lib/useChain';
import { useRulesets } from '../../lib/useRulesets';
import { useWallet } from '../../lib/useWallet';

const BLANK: MandateFields = {
  cap: '',
  perTxMax: '',
  expiryDays: '',
  merchant: '',
  purpose: '',
};

export default function NewRuleScreen() {
  const params = useLocalSearchParams<{
    template?: string;
    ruleset?: string;
    version?: string;
    from?: string;
  }>();
  const chain = useChain();
  const stored = useRulesets();
  const sourceMandate = params.from
    ? chain.mandates.find((row) => row.address === params.from)
    : null;
  const selectedRuleset: Ruleset | null = useMemo(() => {
    if (!params.ruleset || params.ruleset === 'new') {
      return null;
    }
    const version = params.version ? Number.parseInt(params.version, 10) : NaN;
    return (
      stored.rulesets.find(
        (row) => row.id === params.ruleset && (Number.isNaN(version) || row.version === version),
      ) ?? null
    );
  }, [params.ruleset, params.version, stored.rulesets]);

  const waitingRuleset = Boolean(params.ruleset && params.ruleset !== 'new' && !stored.ready);
  const waitingFrom = Boolean(params.from && chain.mandateStatus === 'not-read');
  if (waitingRuleset || waitingFrom) {
    return (
      <Screen>
        <TopBar back="Rules" />
        <EmptyState>Reading this phone and the chain.</EmptyState>
      </Screen>
    );
  }

  const template = params.template ? TEMPLATES.find((row) => row.id === params.template) : undefined;
  const start: MandateFields = selectedRuleset
    ? {
        cap: selectedRuleset.cap,
        perTxMax: selectedRuleset.perTxMax,
        expiryDays: selectedRuleset.expiryDays,
        merchant: selectedRuleset.merchant,
        purpose: applyRuleset(selectedRuleset).purpose,
      }
    : sourceMandate
      ? {
          cap: formatBaseUnits(sourceMandate.cap, chain.decimals),
          perTxMax: formatBaseUnits(sourceMandate.perTxMax, chain.decimals),
          expiryDays: '7',
          merchant: sourceMandate.merchant,
          purpose: displayPurpose(sourceMandate.purpose),
        }
      : template
        ? applyTemplate(template)
        : BLANK;

  const formKey = `${params.template ?? ''}:${params.ruleset ?? ''}:${params.version ?? ''}:${params.from ?? ''}`;

  return (
    <RuleCompose
      key={formKey}
      initial={start}
      selectedRuleset={selectedRuleset}
      sourceMandate={sourceMandate ?? null}
      authoring={params.ruleset === 'new' || Boolean(sourceMandate)}
      applying={selectedRuleset != null}
    />
  );
}

function RuleCompose({
  initial,
  selectedRuleset,
  sourceMandate,
  authoring,
  applying,
}: {
  initial: MandateFields;
  selectedRuleset: Ruleset | null;
  sourceMandate: MandateAccount | null;
  authoring: boolean;
  applying: boolean;
}) {
  const chain = useChain();
  const wallet = useWallet();
  const stored = useRulesets();
  const router = useRouter();
  const [fields, setFields] = useState<MandateFields>(initial);
  const [rulesetName, setRulesetName] = useState(selectedRuleset?.name ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const setField = (key: keyof MandateFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const openFromFields = async (purpose: string) => {
    if (!chain.config) {
      throw new Error(chain.configError ?? 'Config is missing');
    }
    const cap = parseBaseUnits(fields.cap, chain.decimals);
    const perTxMax = parseBaseUnits(fields.perTxMax, chain.decimals);
    const days = Number.parseInt(fields.expiryDays.trim(), 10);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('expiry must be a whole number of days from now');
    }
    if (purpose.trim().length === 0) {
      throw new Error('purpose is required');
    }
    if (purpose.trim().length > PURPOSE_MAX_LEN) {
      throw new Error(`purpose is longer than ${PURPOSE_MAX_LEN} characters`);
    }
    assertPurposeMayOpen(purpose, applying);
    const merchant = new PublicKey(fields.merchant.trim());
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
    return chain.open({
      merchant,
      cap,
      perTxMax,
      expiresAt,
      purpose: purpose.trim(),
    });
  };

  const onOpen = async () => {
    setFormError(null);
    setMessage(null);
    try {
      const purpose =
        applying && selectedRuleset ? applyRuleset(selectedRuleset).purpose : fields.purpose;
      const result = await openFromFields(purpose);
      setMessage(`Opened on chain. Rule ${result.mandate.address}.`);
      router.replace(`/rule/${result.mandate.address}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Open failed');
    }
  };

  const onSaveRuleset = async () => {
    setFormError(null);
    setMessage(null);
    try {
      const name = rulesetName.trim();
      if (name.length === 0) {
        throw new Error('ruleset name is required');
      }
      const id = rulesetSlug(name);
      const saved = await stored.save({
        id,
        name,
        cap: fields.cap,
        perTxMax: fields.perTxMax,
        expiryDays: fields.expiryDays,
        merchant: fields.merchant,
        purpose: displayPurpose(fields.purpose),
      });
      const stamped = stampPurpose(displayPurpose(fields.purpose), saved.id, saved.version);
      setMessage(
        `Saved ${saved.name} v${saved.version} on this phone. The ruleset itself is not on chain. Apply it to a new agent to stamp "${stamped}" into the purpose.`,
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const title = applying && selectedRuleset
    ? `Apply ${selectedRuleset.name} v${selectedRuleset.version}`
    : authoring
      ? 'Author a ruleset'
      : 'Write a rule';

  return (
    <Screen>
      <TopBar back="Rules" />
      <ConnectGate>
        <Text style={styles.h2}>{title}</Text>
        {sourceMandate ? (
          <EmptyState>
            This rule is already on chain and cannot change. Saving writes a new ruleset version on
            this phone. Apply it to a new agent. The existing agent keeps these numbers.
          </EmptyState>
        ) : applying && selectedRuleset ? (
          <EmptyState>
            {`One action opens a new rule for a new agent, with ${selectedRuleset.name} v${selectedRuleset.version} stamped into the purpose. The ruleset file stays on this phone.`}
          </EmptyState>
        ) : (
          <EmptyState>
            One Seed Vault signature opens the rule and delegates the cap in the same transaction.
            Confirmation is read back from chain, not from this form.
          </EmptyState>
        )}

        {authoring ? (
          <Field
            label="Ruleset name"
            value={rulesetName}
            onChangeText={setRulesetName}
            placeholder="Mint budget"
          />
        ) : null}
        <Field
          label="Cap"
          value={fields.cap}
          onChangeText={(text) => setField('cap', text)}
          placeholder="total, in tokens"
          editable={!applying}
        />
        <Field
          label="Per-payment maximum"
          value={fields.perTxMax}
          onChangeText={(text) => setField('perTxMax', text)}
          placeholder="largest single payment"
          editable={!applying}
        />
        <Field
          label="Expiry (days from now)"
          value={fields.expiryDays}
          onChangeText={(text) => setField('expiryDays', text)}
          placeholder="7"
          editable={!applying}
        />
        <Field
          label="Payee"
          value={fields.merchant}
          onChangeText={(text) => setField('merchant', text)}
          placeholder="the only wallet that may be paid"
        />
        <Field
          label="Purpose"
          value={applying && selectedRuleset ? applyRuleset(selectedRuleset).purpose : fields.purpose}
          onChangeText={(text) => setField('purpose', text)}
          placeholder="in your own words"
          multiline
          editable={!applying}
        />

        {applying ? (
          <Button
            label={wallet.busy ? 'Waiting on Seed Vault...' : 'Apply to a new agent'}
            accessibilityLabel="Apply to a new agent"
            busy={wallet.busy}
            onPress={() => {
              void onOpen();
            }}
          />
        ) : (
          <View style={styles.actions}>
            {authoring ? (
              <Button
                label="Save ruleset on this phone"
                invert={false}
                onPress={() => {
                  void onSaveRuleset();
                }}
              />
            ) : null}
            <Button
              label={wallet.busy ? 'Waiting on Seed Vault...' : 'Open this rule'}
              accessibilityLabel="Open this rule"
              busy={wallet.busy}
              onPress={() => {
                void onOpen();
              }}
            />
          </View>
        )}
        {formError ? <Text style={styles.msg}>{formError}</Text> : null}
        {message ? <Text style={styles.msg}>{message}</Text> : null}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  actions: {
    gap: 10,
    alignSelf: 'stretch',
  },
  msg: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
});
