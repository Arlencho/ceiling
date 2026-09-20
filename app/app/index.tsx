import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useWallet } from '../lib/useWallet';
import { truncateAddress } from '../lib/wallet';

const THESIS =
  'The owner key lives in Seed Vault and never leaves it. The agent key holds authority and no funds.';

export default function HomeScreen() {
  const wallet = useWallet();
  const connected = wallet.ownerPublicKey !== null && wallet.agentPublicKey !== null;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        <Text style={styles.name}>Veto</Text>
        <Text style={styles.thesis}>{THESIS}</Text>
        {!wallet.ready ? (
          <ActivityIndicator color="#F5F5F5" />
        ) : connected && wallet.ownerPublicKey && wallet.agentPublicKey ? (
          <>
            <Text style={styles.status}>Connected</Text>
            <View style={styles.keys}>
              <KeyRow label="Owner" address={wallet.ownerPublicKey} />
              <KeyRow label="Agent" address={wallet.agentPublicKey} />
            </View>
            <WalletButton
              label={wallet.busy ? 'Disconnecting...' : 'Disconnect'}
              accessibilityLabel="Disconnect"
              busy={wallet.busy}
              onPress={() => {
                void wallet.disconnect();
              }}
            />
          </>
        ) : (
          <WalletButton
            label={wallet.busy ? 'Connecting...' : 'Connect'}
            accessibilityLabel="Connect"
            busy={wallet.busy}
            onPress={() => {
              void wallet.connect();
            }}
          />
        )}
        {wallet.error ? <Text style={styles.error}>{wallet.error}</Text> : null}
      </View>
    </SafeAreaView>
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

function WalletButton({
  label,
  accessibilityLabel,
  busy,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.connect,
        pressed && styles.connectPressed,
        busy && styles.connectBusy,
      ]}
    >
      <Text style={styles.connectLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0B0B0B',
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    paddingHorizontal: 24,
  },
  name: {
    color: '#F5F5F5',
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  thesis: {
    color: '#A3A3A3',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 340,
  },
  status: {
    color: '#F5F5F5',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  keys: {
    alignSelf: 'stretch',
    gap: 12,
    maxWidth: 340,
    width: '100%',
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  keyLabel: {
    color: '#A3A3A3',
    fontSize: 15,
    fontWeight: '600',
  },
  keyValue: {
    color: '#F5F5F5',
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: '600',
  },
  connect: {
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    minWidth: 200,
    paddingHorizontal: 28,
    paddingVertical: 14,
    alignItems: 'center',
  },
  connectPressed: {
    opacity: 0.7,
  },
  connectBusy: {
    opacity: 0.5,
  },
  connectLabel: {
    color: '#0B0B0B',
    fontSize: 17,
    fontWeight: '600',
  },
  error: {
    color: '#F87171',
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 340,
  },
});
