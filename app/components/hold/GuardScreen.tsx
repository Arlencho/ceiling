import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Lamp } from '../backglass/Lamp';
import { colors, fonts, radii, space } from '../theme';
import { HoldSign, HoldTop, StatusBlock } from './chrome';

export type GuardWaiting = {
  amountLabel: string;
  destinationLabel: string;
  untilLabel: string;
};

export type GuardResult = {
  line: string;
  link: string;
};

export function GuardScreen({
  network,
  status,
  error,
  ownerLabel,
  amountLabel,
  hasMoney,
  tokenName,
  frozen,
  waiting,
  missingWithdrawal = false,
  moreWaiting = 0,
  changeLines,
  changeAtLabel,
  safeAddress,
  safeLabel,
  result,
  onClose,
  onStop,
  onFreeze,
  onRecover,
  onOpenLink,
  signingDisabled = false,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  ownerLabel: string;
  amountLabel: string;
  hasMoney: boolean;
  missingWithdrawal?: boolean;
  tokenName: string;
  frozen: boolean;
  waiting: GuardWaiting | null;
  moreWaiting?: number;
  changeLines: readonly string[];
  changeAtLabel: string | null;
  safeAddress: string;
  safeLabel: string;
  result: GuardResult | null;
  onClose: () => void;
  onStop: () => Promise<void>;
  onFreeze: () => Promise<void>;
  onRecover: () => Promise<void>;
  onOpenLink: (link: string) => void;
  signingDisabled?: boolean;
}) {
  const [confirmRecover, setConfirmRecover] = useState(false);
  const nothingWaiting = !waiting && moreWaiting === 0 && changeLines.length === 0;

  return (
    <View style={styles.wrap}>
      <HoldTop title="You are the guardian" network={network} onBack={onClose} backLabel="Close" />
      <StatusBlock status={status} error={error} empty="This vault could not be found.">
        {result ? (
          <View style={styles.result} accessibilityLabel="Confirmed on the blockchain">
            <Text style={styles.kicker}>Confirmed on the blockchain</Text>
            <Text style={styles.resultLine}>{result.line}</Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="See the transaction"
              onPress={() => onOpenLink(result.link)}
            >
              <Text style={styles.link}>See the transaction</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.plate}>
          <Lamp
            state={frozen || !nothingWaiting ? 'pulse' : 'on'}
            litColor={frozen ? colors.refused : nothingWaiting ? colors.paid : colors.tilt}
            size={14}
            accessibilityLabel={frozen ? 'Frozen' : nothingWaiting ? 'Normal' : 'Waiting'}
          />
          <Text style={styles.plateWord}>{frozen ? 'Frozen' : nothingWaiting ? 'Normal' : 'Waiting'}</Text>
        </View>
        <Text style={styles.body}>
          This vault belongs to {ownerLabel}. It holds {amountLabel} {tokenName}. Your key is its guardian, so
          you can brake it with one signature.
        </Text>
        {missingWithdrawal ? <Text style={styles.body}>The withdrawal you were told about is no longer waiting.</Text> : null}
        <Text style={styles.body}>You can also move everything to the safe address at any time. It can only go there.</Text>
        {waiting ? (
          <View style={styles.card}>
            <Text style={styles.kicker}>Waiting to leave</Text>
            <Text style={styles.h1}>
              {waiting.amountLabel} <Text style={styles.unit}>{tokenName}</Text>
            </Text>
            <Text style={styles.body}>To {waiting.destinationLabel}. {waiting.untilLabel}</Text>
            {moreWaiting > 0 ? (
              <Text style={styles.hint}>
                {moreWaiting === 1 ? '1 more withdrawal is' : `${moreWaiting} more withdrawals are`} also waiting.
                Freezing stops all of them.
              </Text>
            ) : null}
          </View>
        ) : null}
        {changeLines.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.kicker}>A settings change is waiting</Text>
            {changeLines.map((line) => (
              <Text key={line} style={styles.body}>
                {line}.
              </Text>
            ))}
            {changeAtLabel ? <Text style={styles.hint}>It applies {changeAtLabel}.</Text> : null}
            <Text style={styles.hint}>
              Freezing does not stop the change, but withdrawals cannot leave while the vault is frozen.
            </Text>
          </View>
        ) : null}
        {nothingWaiting && !frozen && !missingWithdrawal ? (
          <Text style={styles.body}>Nothing is waiting right now. This phone tells you when something is.</Text>
        ) : null}
        {frozen ? <Text style={styles.body}>The vault is frozen. Withdrawals cannot leave.</Text> : null}
        {waiting ? (
          <HoldSign
            name="guard-stop"
            label="Stop this withdrawal"
            hint={frozen ? 'Removes it for good. The vault stays frozen.' : `${waiting.amountLabel} ${tokenName} stays in the vault. One signature with your guardian key.`}
            disabled={signingDisabled}
            onSign={onStop}
          />
        ) : null}
        {!frozen ? (
          <HoldSign
            name="guard-freeze"
            label="Freeze the vault"
            hint="Withdrawals wait until the owner and you unfreeze it. One signature with your guardian key."
            disabled={signingDisabled}
            onSign={onFreeze}
          />
        ) : null}
        {hasMoney ? (
          confirmRecover ? (
            <View style={styles.card}>
              <Text style={styles.body}>
                All {amountLabel} {tokenName} goes to the safe address {safeAddress}. Nothing else can receive it.
              </Text>
              <HoldSign
                name="guard-recover"
                label="Move everything to the safe address"
                hint={`${amountLabel} ${tokenName} to ${safeLabel}. One signature with your guardian key.`}
                disabled={signingDisabled}
                onSign={onRecover}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Keep the money in the vault"
                onPress={() => setConfirmRecover(false)}
                style={styles.keep}
              >
                <Text style={styles.center}>Keep the money in the vault</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move everything to the safe address"
              onPress={() => setConfirmRecover(true)}
              style={styles.ghost}
            >
              <Text style={styles.ghostTitle}>Move everything to the safe address</Text>
              <Text style={styles.hint}>
                {amountLabel} {tokenName} to {safeLabel}
              </Text>
            </Pressable>
          )
        ) : null}
      </StatusBlock>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  plate: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radii.plaque,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.7)',
    backgroundColor: colors.reelWell,
    paddingVertical: space.lg,
    paddingHorizontal: space.xxxl,
  },
  plateWord: {
    color: colors.bone,
    fontFamily: fonts.sansBold,
    fontSize: 14,
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  h1: { color: colors.bone, fontFamily: fonts.serifLight, fontSize: 36, lineHeight: 40 },
  unit: { fontFamily: fonts.sans, fontSize: 13, color: colors.body },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  hint: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  card: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.brassSoft,
    backgroundColor: colors.surface,
    padding: space.xxxl,
    gap: space.md,
  },
  result: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.paid,
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.sm,
  },
  resultLine: { color: colors.bone, fontFamily: fonts.sansSemibold, fontSize: 15, lineHeight: 21 },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  link: { color: colors.brass, fontFamily: fonts.sansBold, fontSize: 14 },
  ghost: {
    minHeight: 52,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.md,
  },
  ghostTitle: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 15 },
  keep: { minHeight: 48, justifyContent: 'center' },
  center: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
