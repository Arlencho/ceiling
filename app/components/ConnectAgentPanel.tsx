import { StyleSheet, Text, View } from 'react-native';

import { AGENT_CONNECT_LINE } from '../lib/agentConnect';
import { colors, fonts, type as typeScale } from './theme';
import { Button } from './Button';
import { QrCode } from './QrCode';

export function ConnectAgentPanel({
  rows,
  configJson,
  status,
  onCopy,
  summary,
}: {
  rows: readonly { label: string; value: string }[];
  configJson: string | null;
  status: string | null;
  onCopy: (json: string) => void;
  summary?: string | null;
}) {
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Give your agent its setup.</Text>
      <Text style={styles.body}>
        Your agent needs this to use the rule. Let it scan the code, or copy the text to it.
      </Text>
      {summary ? <Text style={styles.summary}>{summary}</Text> : null}
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
          <Text style={styles.body}>
            If your agent runs the Veto companion, it finds this rule by itself. This setup text is for developers.
          </Text>
          <Button
            label="Copy setup text"
            accessibilityLabel="Copy setup text"
            invert={false}
            onPress={() => {
              onCopy(configJson);
            }}
          />
          <Text style={styles.body}>{`The text holds the rule's address and its limits. Never your key.`}</Text>
          <QrCode value={configJson} />
        </View>
      ) : status ? (
        <Text style={styles.body}>{status}</Text>
      ) : (
        <Text style={styles.body}>Waiting for the rule.</Text>
      )}
      <Text style={styles.body}>{AGENT_CONNECT_LINE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 12,
    alignSelf: 'stretch',
  },
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 28,
    lineHeight: 32,
    color: colors.bone,
  },
  summary: {
    ...typeScale.body,
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
    fontFamily: fonts.sansMedium,
  },
  value: {
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.mono,
  },
  body: {
    ...typeScale.body,
  },
});
