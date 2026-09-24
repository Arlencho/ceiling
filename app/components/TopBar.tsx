import { usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { leaveHelpOrOnboarding, openHelp, showHelpControl } from '../lib/helpNavigation';
import { colors, fonts } from './theme';

export function TopBar({
  title,
  meta,
  back,
  help = true,
}: {
  title?: string;
  meta?: string;
  back?: string;
  help?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const showHelp = showHelpControl(help, pathname);
  return (
    <View style={styles.row}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={back}
          onPress={() => leaveHelpOrOnboarding(router, pathname)}
          hitSlop={8}
        >
          <Text style={styles.back}>{`\u2190 ${back}`}</Text>
        </Pressable>
      ) : (
        <Text style={styles.brand}>
          Veto{title ? <Text style={styles.brandMuted}>{` ${title}`}</Text> : null}
        </Text>
      )}
      <View style={styles.right}>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        {showHelp ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Help"
            onPress={() => openHelp(router, pathname)}
            hitSlop={8}
          >
            <Text style={styles.help}>Help</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  brand: {
    color: colors.text,
    fontSize: 22,
    fontFamily: fonts.serif,
  },
  brandMuted: {
    color: colors.muted,
    fontStyle: 'italic',
    fontFamily: fonts.serif,
  },
  back: {
    color: colors.body,
    fontSize: 15,
    fontWeight: '500',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  help: {
    color: colors.body,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
});
