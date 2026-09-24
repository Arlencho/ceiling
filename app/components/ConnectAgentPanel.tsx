import { StyleSheet, Text, View } from 'react-native';

import { AGENT_CONNECT_LINE } from '../lib/agentConnect';
import { Button } from './Button';
import { QrCode } from './QrCode';
import { SectionTitle } from './SectionTitle';
import { colors, fonts } from './theme';

export function ConnectAgentPanel({
  rows,
  configJson,
  status,
  onCopy,
}: {
  rows: readonly { label: string; value: string }[];
  configJson: string | null;
  status: string | null;
  onCopy: (json: string) => void;
}) {
  return (
    <View style={styles.panel} accessibilityLabel="Connect your agent">
      <SectionTitle>Connect your agent</SectionTitle>
      {configJson ? (
        <View style={styles.block}>
          {rows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.label}>{row.label}</Text>
              <Text selectable style={styles.value}>
                {row.value}
              </Text>
            </View>
          ))}
          <Button
            label="Copy all"
            accessibilityLabel="Copy all"
            invert={false}
            onPress={() => {
              onCopy(configJson);
            }}
          />
          <QrCode value={configJson} />
        </View>
      ) : status ? (
        <Text style={styles.status}>{status}</Text>
      ) : null}
      <Text style={styles.line}>{AGENT_CONNECT_LINE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 12,
    alignSelf: 'stretch',
  },
  block: {
    gap: 10,
    alignSelf: 'stretch',
  },
  row: {
    gap: 4,
    alignSelf: 'stretch',
  },
  label: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '500',
  },
  value: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  status: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
  },
  line: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
  },
});
