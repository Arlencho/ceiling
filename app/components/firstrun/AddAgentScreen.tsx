import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, fonts, radii, space, type as typeScale } from '../theme';
import { FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

export function AddAgentScreen({
  cluster,
  busy = false,
  error = null,
  onScan,
  onPaste,
  onCreateTest,
  onHow,
  onBack,
  view = 'normal',
}: {
  cluster: string | null;
  busy?: boolean;
  error?: string | null;
  onScan: () => void;
  onPaste: () => void;
  onCreateTest: () => void;
  onHow: () => void;
  onBack?: () => void;
  view?: ScreenView;
}) {
  return (
    <FirstRunChrome
      stage="agent"
      cluster={cluster}
      title="Add your agent"
      onBack={onBack}
      view={view}
      error={error}
      empty="Connect a wallet before you add an agent."
      footer={<QuietButton label="How Veto works" onPress={onHow} />}
    >
      <Text style={styles.title}>Bring in your agent.</Text>
      <Text style={styles.body}>Your agent is the program that will ask you to pay. Pick how to add it.</Text>
      <Choice
        title="Scan your agent's code"
        detail="Your agent sends you a rule request as a QR code or a link. It fills in the rule for you."
        badge="Recommended"
        disabled={busy}
        onPress={onScan}
      />
      <Choice
        title="Paste your agent's address"
        detail="You add the address yourself, then write the rule."
        disabled={busy}
        onPress={onPaste}
      />
      <Choice
        title="Create a test agent on this phone"
        detail="The phone makes a test agent key so you can try Veto."
        badge="Testing only."
        disabled={busy}
        onPress={onCreateTest}
      />
      <Text style={styles.body}>
        {`Your agent's key can only ask. It holds no money and it cannot take yours. Only a rule you approve lets it be paid.`}
      </Text>
    </FirstRunChrome>
  );
}

function Choice({
  title,
  detail,
  badge,
  disabled,
  onPress,
}: {
  title: string;
  detail: string;
  badge?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${title}. ${badge}` : title}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={styles.choice}
    >
      <Text style={styles.choiceTitle}>{title}</Text>
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      <Text style={styles.detail}>{detail}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 34,
    lineHeight: 37,
    color: colors.bone,
  },
  body: {
    ...typeScale.body,
  },
  choice: {
    gap: space.xs,
    padding: space.lg,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    minHeight: 44,
  },
  choiceTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 22,
    color: colors.bone,
  },
  badge: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    color: colors.brass,
  },
  detail: {
    ...typeScale.caption,
  },
});
