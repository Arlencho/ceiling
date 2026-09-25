import { PublicKey } from '@solana/web3.js';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  addressLine,
  agentFieldReady,
  approvalSentence,
  canApprove,
  capFromRing,
  clampTemplate,
  clampToRequest,
  customDateWithin,
  DURATION_DAYS,
  durationChipAllowed,
  expiryFromDays,
  formatUntilDate,
  fractionFromAmount,
  partyDisplay,
  payeeFieldReady,
  purposeFieldReady,
  templateCapCeiling,
  templateLimits,
} from '../lib/approval';
import { loadAddressBook, saveAddressBook, withSavedName } from '../lib/addressBook';
import { parseOptionalAgentAddress } from '../lib/agentAddress';
import { createClient } from '../lib/chain';
import { formatBaseUnits } from '../lib/format';
import { secureStore } from '../lib/mwa';
import { evaluatePresign, type PresignObservation } from '../lib/presign';
import { observePresign } from '../lib/presignRead';
import { canonicalAddress, type RuleRequestV1 } from '../lib/ruleRequest';
import { takeAddressScan } from '../lib/scanHandoff';
import { BUILD_YOUR_OWN_IDS, templateById, type MandateTemplate } from '../lib/templates';
import { useChain } from '../lib/useChain';
import { useWallet } from '../lib/useWallet';
import { AddressActions } from './AddressActions';
import { Button } from './Button';
import { CapRing } from './CapRing';
import { ConnectGate } from './ConnectGate';
import { Field } from './Field';
import { MaxSlider } from './MaxSlider';
import { RuleScreen } from './RuleScreen';
import { TopBar } from './TopBar';
import { colors, fonts } from './theme';

type DurationChoice = { kind: 'days'; days: number } | { kind: 'date'; iso: string };

export function ApprovalScreen({
  mode,
  request,
  invalidReason,
  templateId,
}: {
  mode: 'request' | 'template';
  request: RuleRequestV1 | null;
  invalidReason: string | null;
  templateId?: string;
}) {
  if (invalidReason || (mode === 'request' && !request)) {
    return (
      <RuleScreen>
        <TopBar back="Rules" />
        <Text style={styles.h2}>This request is not valid.</Text>
        <Text style={styles.body}>{invalidReason ?? 'This is not a rule request.'}</Text>
      </RuleScreen>
    );
  }

  return <ApprovalCard mode={mode} request={request} templateId={templateId ?? 'charging-agent'} />;
}

function ApprovalCard({
  mode,
  request,
  templateId,
}: {
  mode: 'request' | 'template';
  request: RuleRequestV1 | null;
  templateId: string;
}) {
  const chain = useChain();
  const wallet = useWallet();
  const router = useRouter();
  const initialTemplate = templateById(templateId) ?? templateById('charging-agent');
  const [template, setTemplate] = useState<MandateTemplate | null>(initialTemplate ?? null);
  const [agentText, setAgentText] = useState(request?.agent ?? '');
  const [payeeText, setPayeeText] = useState(request?.payee ?? '');
  const [purpose, setPurpose] = useState(request?.purpose ?? initialTemplate?.fields.purpose ?? '');
  const [capTouched, setCapTouched] = useState<bigint | null>(request ? request.cap : null);
  const [maxTouched, setMaxTouched] = useState<bigint | null>(request ? request.max : null);
  const [choice, setChoice] = useState<DurationChoice>({
    kind: 'days',
    days: request?.days ?? Number(initialTemplate?.fields.expiryDays ?? '7'),
  });
  const [customDate, setCustomDate] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  const [book, setBook] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState({ agent: false, payee: false });
  const [naming, setNaming] = useState<'agent' | 'payee' | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [observation, setObservation] = useState<{ key: string; value: PresignObservation } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openedAddress, setOpenedAddress] = useState<string | null>(null);
  const openingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadAddressBook(secureStore).then((loaded) => {
      if (!cancelled) {
        setBook(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (request) {
        return;
      }
      const agent = takeAddressScan('agent');
      if (agent) {
        setAgentText(agent);
      }
      const payee = takeAddressScan('payee');
      if (payee) {
        setPayeeText(payee);
      }
    }, [request]),
  );

  const mintText = request?.mint ?? chain.config?.mint ?? null;
  const payeeCanonical = canonicalAddress(payeeText.trim());
  const agentCanonical = canonicalAddress(agentText.trim());
  const readKey = `${chain.config?.rpcUrl ?? ''}|${wallet.ownerPublicKey ?? ''}|${mintText ?? ''}|${payeeCanonical ?? ''}`;
  const liveObservation = observation?.key === readKey ? observation.value : null;

  useEffect(() => {
    if (!chain.config || !wallet.ownerPublicKey || !mintText) {
      return;
    }
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintText);
    } catch {
      return;
    }
    let cancelled = false;
    const key = `${chain.config.rpcUrl}|${wallet.ownerPublicKey}|${mintText}|${payeeCanonical ?? ''}`;
    const client = createClient(chain.config);
    void observePresign({
      connection: client.connection,
      owner: new PublicKey(wallet.ownerPublicKey),
      payee: payeeCanonical ? new PublicKey(payeeCanonical) : null,
      mint,
      cluster: chain.config.explorerCluster,
    })
      .then((next) => {
        if (!cancelled) {
          setObservation({ key, value: next });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setObservation(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chain.config, mintText, payeeCanonical, wallet.ownerPublicKey]);

  const decimals = liveObservation?.mintReadable ? liveObservation.decimals : null;
  const seeded = !request && template && decimals != null ? templateLimits(template, decimals) : null;
  const cap = capTouched ?? seeded?.cap ?? null;
  const maxPay = maxTouched ?? seeded?.max ?? null;

  const requestCeiling = useMemo(() => {
    if (!request) {
      return null;
    }
    return {
      cap: request.cap,
      max: request.max,
      expiresAt: expiryFromDays(request.days, openedAt),
    };
  }, [openedAt, request]);

  const expiresAt = useMemo(() => {
    if (choice.kind === 'days') {
      const at = expiryFromDays(choice.days, openedAt);
      if (requestCeiling && at > requestCeiling.expiresAt) {
        return requestCeiling.expiresAt;
      }
      return at;
    }
    return customDateWithin(choice.iso, openedAt, requestCeiling?.expiresAt ?? null);
  }, [choice, openedAt, requestCeiling]);

  const applyLimits = (nextCap: bigint, nextMax: bigint) => {
    if (expiresAt == null) {
      return;
    }
    if (requestCeiling) {
      const clamped = clampToRequest(requestCeiling, { cap: nextCap, max: nextMax, expiresAt });
      setCapTouched(clamped.cap);
      setMaxTouched(clamped.max);
      return;
    }
    if (!template || decimals == null) {
      return;
    }
    const ceiling = templateCapCeiling(templateLimits(template, decimals).cap);
    const clamped = clampTemplate({
      capCeiling: ceiling,
      chosen: { cap: nextCap, max: nextMax, expiresAt },
    });
    setCapTouched(clamped.cap);
    setMaxTouched(clamped.max);
  };

  const capCeiling = request
    ? request.cap
    : template && decimals != null
      ? templateCapCeiling(templateLimits(template, decimals).cap)
      : null;
  const maxCeiling = cap != null && request ? (request.max < cap ? request.max : cap) : cap;

  const agentParty = partyDisplay({
    address: agentCanonical,
    claimedLabel: request?.agentLabel ?? null,
    savedName: agentCanonical ? (book[agentCanonical] ?? null) : null,
  });
  const payeeParty = partyDisplay({
    address: payeeCanonical,
    claimedLabel: request?.payeeLabel ?? null,
    savedName: payeeCanonical ? (book[payeeCanonical] ?? null) : null,
  });
  const sentence =
    cap != null && maxPay != null && expiresAt != null && decimals != null
      ? approvalSentence({
          agent: addressLine(agentParty, false).primary || 'the agent',
          payee: addressLine(payeeParty, false).primary || 'the payee',
          max: formatBaseUnits(maxPay, decimals),
          cap: formatBaseUnits(cap, decimals),
          until: formatUntilDate(expiresAt),
        })
      : null;

  const checks =
    liveObservation && cap != null
      ? evaluatePresign({
          ...liveObservation,
          cap,
          payeeHasTokenAccount: payeeFieldReady(payeeText) ? liveObservation.payeeHasTokenAccount : null,
        })
      : [];
  const ready = canApprove({
    checks,
    payeeReady: payeeFieldReady(payeeText),
    agentReady: agentFieldReady(agentText, wallet.ownerPublicKey, payeeCanonical),
    purposeReady: purposeFieldReady(request ? request.purpose : purpose),
    expiryReady: expiresAt != null && expiresAt > BigInt(Math.floor(openedAt / 1000)),
  });

  const selectTemplate = (id: string) => {
    const next = templateById(id);
    if (!next) {
      return;
    }
    setTemplate(next);
    setPurpose(next.fields.purpose);
    setChoice({ kind: 'days', days: Number(next.fields.expiryDays) });
    setCustomDate('');
    setDateError(null);
    setCapTouched(null);
    setMaxTouched(null);
  };

  const onChip = (days: number) => {
    if (!durationChipAllowed(days, request?.days ?? null)) {
      return;
    }
    setChoice({ kind: 'days', days });
    setCustomDate('');
    setDateError(null);
  };

  const onCustomDate = (text: string) => {
    setCustomDate(text);
    const at = customDateWithin(text, openedAt, requestCeiling?.expiresAt ?? null);
    if (!at) {
      setDateError('Use a date YYYY-MM-DD that is still ahead, and not later than this request allows.');
      return;
    }
    setDateError(null);
    setChoice({ kind: 'date', iso: text });
  };

  const saveName = async (which: 'agent' | 'payee') => {
    const address = which === 'agent' ? agentCanonical : payeeCanonical;
    if (!address) {
      return;
    }
    try {
      const next = withSavedName(book, address, nameDraft);
      await saveAddressBook(secureStore, next);
      setBook(next);
      setNaming(null);
      setNameDraft('');
      setNameError(null);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'The name could not be saved.');
    }
  };

  const onApprove = async () => {
    if (openingRef.current || openedAddress || !ready || cap == null || maxPay == null || expiresAt == null) {
      return;
    }
    openingRef.current = true;
    setFormError(null);
    try {
      const merchant = new PublicKey(payeeText.trim());
      const agent = parseOptionalAgentAddress({
        text: agentText,
        owner: wallet.ownerPublicKey,
        payee: merchant,
      });
      const result = await chain.open({
        merchant,
        cap,
        perTxMax: maxPay,
        expiresAt,
        purpose: request ? request.purpose : purpose.trim(),
        ...(request ? { mint: new PublicKey(request.mint) } : {}),
        ...(agent ? { agent } : {}),
      });
      setOpenedAddress(result.mandate.address);
      router.replace(`/rule/${result.mandate.address}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Open failed');
    } finally {
      openingRef.current = false;
    }
  };

  const footer = wallet.ownerPublicKey ? (
    <View style={styles.footer}>
      {formError ? <Text style={styles.body}>{formError}</Text> : null}
      {openedAddress ? (
        <Text style={styles.body}>{`Opened on chain. Rule ${openedAddress}.`}</Text>
      ) : (
        <Button
          label={wallet.busy ? 'Waiting on Seed Vault...' : 'Approve with Seed Vault'}
          accessibilityLabel="Approve with Seed Vault"
          busy={wallet.busy}
          disabled={!ready}
          onPress={() => {
            void onApprove();
          }}
        />
      )}
    </View>
  ) : null;

  return (
    <RuleScreen footer={footer}>
      <TopBar back="Rules" />
      <ConnectGate>
        <Text style={styles.h2}>{request ? 'Approve this request' : 'Build a rule'}</Text>
        {sentence ? <Text style={styles.sentence}>{sentence}</Text> : (
          <Text style={styles.body}>Reading the mint from the chain.</Text>
        )}
        {!request && template ? (
          <View style={styles.chips}>
            {BUILD_YOUR_OWN_IDS.map((id) => {
              const row = templateById(id);
              const selected = template.id === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={row?.title ?? id}
                  onPress={() => selectTemplate(id)}
                  style={[styles.chip, selected && styles.chipOn]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextOn]}>{row?.title ?? id}</Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scan a request"
              onPress={() => router.push('/scan?target=request')}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Scan a request</Text>
            </Pressable>
          </View>
        ) : null}

        <PartyBlock
          role="Agent"
          party={agentParty}
          revealed={revealed.agent}
          onReveal={() => setRevealed((prev) => ({ ...prev, agent: !prev.agent }))}
          onSave={() => {
            setNaming('agent');
            setNameDraft('');
            setNameError(null);
          }}
        />
        {!request ? (
          <>
            <Field
              label="Agent"
              value={agentText}
              onChangeText={setAgentText}
              placeholder="scan or paste the agent address"
              hint="Leave this empty only for a test. Opening then creates a key on this phone."
            />
            <AddressActions target="agent" onAddress={setAgentText} onInvalid={setFormError} />
            {agentText.trim().length > 0 &&
            !agentFieldReady(agentText, wallet.ownerPublicKey, payeeCanonical) ? (
              <Text style={styles.body}>That agent address cannot be used for this rule.</Text>
            ) : null}
          </>
        ) : null}

        <PartyBlock
          role="Payee"
          party={payeeParty}
          revealed={revealed.payee}
          onReveal={() => setRevealed((prev) => ({ ...prev, payee: !prev.payee }))}
          onSave={() => {
            setNaming('payee');
            setNameDraft('');
            setNameError(null);
          }}
        />
        {!request ? (
          <>
            <Field
              label="Payee"
              value={payeeText}
              onChangeText={setPayeeText}
              placeholder="scan or paste the payee address"
            />
            <AddressActions target="payee" onAddress={setPayeeText} onInvalid={setFormError} />
          </>
        ) : null}

        {naming && (naming === 'agent' ? agentCanonical : payeeCanonical) ? (
          <View style={styles.block}>
            <Field label="Name on this phone" value={nameDraft} onChangeText={setNameDraft} />
            <Button
              label="Save this name"
              accessibilityLabel="Save this name"
              invert={false}
              onPress={() => {
                void saveName(naming);
              }}
            />
            {nameError ? <Text style={styles.body}>{nameError}</Text> : null}
          </View>
        ) : null}

        {cap != null && maxPay != null && capCeiling != null && maxCeiling != null && decimals != null ? (
          <View style={styles.block}>
            <CapRing
              fraction={fractionFromAmount(cap, capCeiling)}
              label={formatBaseUnits(cap, decimals)}
              onFraction={(fraction) => applyLimits(capFromRing({ ceiling: capCeiling, fraction }), maxPay)}
            />
            <MaxSlider
              fraction={fractionFromAmount(maxPay, maxCeiling)}
              label={formatBaseUnits(maxPay, decimals)}
              onFraction={(fraction) => applyLimits(cap, capFromRing({ ceiling: maxCeiling, fraction }))}
            />
          </View>
        ) : null}

        <View style={styles.chips}>
          {DURATION_DAYS.map((days) => {
            const allowed = durationChipAllowed(days, request?.days ?? null);
            const selected = choice.kind === 'days' && choice.days === days;
            return (
              <Pressable
                key={days}
                accessibilityRole="button"
                accessibilityLabel={`${days} days`}
                accessibilityState={{ disabled: !allowed, selected }}
                disabled={!allowed}
                onPress={() => onChip(days)}
                style={[styles.chip, selected && styles.chipOn, !allowed && styles.chipOff]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextOn]}>{days} days</Text>
              </Pressable>
            );
          })}
        </View>
        <Field
          label="Custom date"
          value={customDate}
          onChangeText={onCustomDate}
          placeholder="YYYY-MM-DD"
        />
        {dateError ? <Text style={styles.body}>{dateError}</Text> : null}

        {request ? (
          <Text style={styles.body}>{request.purpose}</Text>
        ) : (
          <Field label="Purpose" value={purpose} onChangeText={setPurpose} multiline />
        )}
        {!request && !purposeFieldReady(purpose) ? (
          <Text style={styles.body}>Add a purpose in your own words.</Text>
        ) : null}

        {!payeeFieldReady(payeeText) ? (
          <Text style={styles.body}>Scan or paste the payee address.</Text>
        ) : null}
        {checks
          .filter((check) => !check.ok && (check.id !== 'payee' || payeeFieldReady(payeeText)))
          .map((check) => (
            <View key={check.id} style={styles.check}>
              <Text style={styles.body}>{check.message}</Text>
              <Text style={styles.fix}>{check.fix}</Text>
            </View>
          ))}
        {!liveObservation && wallet.ownerPublicKey && mintText ? (
          <Text style={styles.body}>Checking the wallet, the token, and the network.</Text>
        ) : null}
        {!mintText ? <Text style={styles.body}>This app has no token mint configured.</Text> : null}
      </ConnectGate>
    </RuleScreen>
  );
}

function PartyBlock({
  role,
  party,
  revealed,
  onReveal,
  onSave,
}: {
  role: string;
  party: ReturnType<typeof partyDisplay>;
  revealed: boolean;
  onReveal: () => void;
  onSave: () => void;
}) {
  if (!party.fullAddress) {
    return null;
  }
  const line = addressLine(party, revealed);
  return (
    <View style={styles.block}>
      <Text style={styles.eyebrow}>{role}</Text>
      {party.savedName ? <Text style={styles.name}>{party.savedName}</Text> : null}
      <View style={styles.partyRow}>
        {party.shortAddress ? <Text style={styles.body}>{party.shortAddress}</Text> : null}
        {party.claim ? <Text style={styles.claim}>{party.claim}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Show full address" onPress={onReveal}>
        <Text style={styles.link}>{line.full ?? 'Show full address'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Save a name for the ${role.toLowerCase()}`} onPress={onSave}>
        <Text style={styles.link}>Save a name</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  sentence: {
    color: colors.text,
    fontSize: 22,
    lineHeight: 30,
    fontFamily: fonts.serif,
  },
  body: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
  },
  fix: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  name: {
    color: colors.text,
    fontSize: 22,
    fontFamily: fonts.serif,
  },
  claim: {
    color: colors.brass,
    fontSize: 14,
  },
  link: {
    color: colors.text,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  partyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'baseline',
  },
  block: {
    gap: 8,
    alignSelf: 'stretch',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipOn: {
    backgroundColor: colors.invert,
    borderColor: colors.invert,
  },
  chipOff: {
    opacity: 0.35,
  },
  chipText: {
    color: colors.body,
    fontSize: 14,
    fontWeight: '500',
  },
  chipTextOn: {
    color: colors.invertText,
  },
  check: {
    gap: 4,
    alignSelf: 'stretch',
  },
  footer: {
    gap: 8,
  },
});
