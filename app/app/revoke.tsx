import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../components/Button';
import { ConnectGate } from '../components/ConnectGate';
import { EmptyState } from '../components/EmptyState';
import { MandateSummary } from '../components/MandateSummary';
import { Screen } from '../components/Screen';
import { ScreenTitle, SectionTitle } from '../components/SectionTitle';
import { colors } from '../components/theme';
import { STATUS_REVOKED } from '../lib/constants';
import { notActiveHint } from '../lib/reasons';
import { useChain } from '../lib/useChain';
import { useWallet } from '../lib/useWallet';

export default function RevokeScreen() {
  const chain = useChain();
  const wallet = useWallet();
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const refresh = chain.refresh;

  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const onRevoke = async () => {
    setFormError(null);
    setMessage(null);
    try {
      const result = await chain.revoke();
      setMessage(
        `Status on chain is now ${result.mandate.status === STATUS_REVOKED ? 'revoked' : String(result.mandate.status)}. The SPL delegation is dropped. Nothing moved beyond what the ledger already records, and no further spend is possible. Opening moved nothing, this revoke moves nothing, and Remaining stays in the wallet.`,
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Revoke failed');
    }
  };

  const alreadyRevoked = chain.mandate?.status === STATUS_REVOKED;

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <ScreenTitle>Revoke</ScreenTitle>
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.error ? <Text style={styles.error}>{chain.error}</Text> : null}
        {!chain.mandate ? (
          <EmptyState>
            {!chain.ready || chain.loading
              ? 'Reading the chain for this owner.'
              : 'No mandate on chain for this owner. There is nothing to revoke, and this screen does not invent one.'}
          </EmptyState>
        ) : (
          <View style={styles.block}>
            <MandateSummary
              heading="Mandate, read from chain"
              mandate={chain.mandate}
              decimals={chain.decimals}
              nowSec={nowSec}
            />
            <SectionTitle>What revoke does</SectionTitle>
            <EmptyState>
              One owner signature sets the status to revoked and drops the SPL delegation. The tokens
              stay in your wallet. They never moved when the mandate opened, and they are not going
              to move because of this revoke.
            </EmptyState>
            <EmptyState>{notActiveHint()}</EmptyState>
            {alreadyRevoked ? (
              <EmptyState>
                This mandate is already revoked on chain. A second revoke is rejected by the program
                and records nothing.
              </EmptyState>
            ) : (
              <Button
                label={wallet.busy ? 'Waiting on Seed Vault...' : 'Revoke mandate'}
                accessibilityLabel="Revoke mandate"
                busy={wallet.busy}
                onPress={() => {
                  void onRevoke();
                }}
              />
            )}
            {message ? <Text style={styles.ok}>{message}</Text> : null}
            {formError ? <Text style={styles.error}>{formError}</Text> : null}
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 16,
    alignSelf: 'stretch',
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  ok: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
});
