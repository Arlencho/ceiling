import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useWallet } from '../lib/useWallet';
import { truncateAddress } from '../lib/wallet';
import { Button } from './Button';
import { colors } from './theme';

const THESIS =
  'The owner key lives in Seed Vault and never leaves it. The agent key holds authority and no funds.';

export function ConnectGate({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const connected = wallet.ownerPublicKey !== null && wallet.agentPublicKey !== null;

  if (!wallet.ready) {
    return <ActivityIndicator color={colors.text} />;
  }

  if (!connected || !wallet.ownerPublicKey || !wallet.agentPublicKey) {
    return (
      <View style={styles.block}>
        <Text style={styles.thesis}>{THESIS}</Text>
        <Button
          label={wallet.busy ? 'Connecting...' : 'Connect'}
          accessibilityLabel="Connect"
          busy={wallet.busy}
          onPress={() => {
            void wallet.connect();
          }}
        />
        {wallet.error ? <Text style={styles.error}>{wallet.error}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.block}>
      <View style={styles.keys}>
        <KeyRow label="Owner" address={wallet.ownerPublicKey} />
        <KeyRow label="Agent" address={wallet.agentPublicKey} />
      </View>
      {children}
      <Button
        label={wallet.busy ? 'Disconnecting...' : 'Disconnect'}
        accessibilityLabel="Disconnect"
        busy={wallet.busy}
        invert={false}
        onPress={() => {
          void wallet.disconnect();
        }}
      />
      {wallet.error ? <Text style={styles.error}>{wallet.error}</Text> : null}
    </View>
  );
}

function KeyRow({ label, address }: { label: string; address: string }) {
  const truncated = truncateAddress(address);
  return (
    <View accessibilityLabel={`${label} ${truncated}`} style={styles.keyRow}>
      <Text style={styles.keyLabel}>{label}</Text>
      <Text selectable style={styles.keyValue}>
        {truncated}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 16,
    alignSelf: 'stretch',
  },
  thesis: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
  },
  keys: {
    gap: 12,
    alignSelf: 'stretch',
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  keyLabel: {
    color: colors.muted,
    fontSize: 15,
    fontWeight: '600',
  },
  keyValue: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
