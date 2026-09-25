import { usePathname, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { showHelpControl } from '../lib/helpNavigation';
import { colors, fonts, space, touchTarget } from './theme';

export function TopBar({
  title,
  meta,
  back,
  help = true,
  center,
  leading,
  accessory,
}: {
  title?: string;
  meta?: string;
  back?: string;
  help?: boolean;
  center?: string;
  leading?: ReactNode;
  accessory?: ReactNode;
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
          onPress={() => router.back()}
          hitSlop={8}
          style={styles.hit}
        >
          <Text style={styles.back}>{`\u2190 ${back}`}</Text>
        </Pressable>
      ) : (
        <View style={styles.brandRow}>
          {leading}
          <Text style={styles.brand}>
            Veto{title ? <Text style={styles.brandMuted}>{` ${title}`}</Text> : null}
          </Text>
        </View>
      )}
      {center ? <Text style={styles.center}>{center}</Text> : null}
      <View style={styles.right}>
        {accessory}
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        {showHelp ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Help"
            onPress={() => router.push('/help')}
            hitSlop={8}
            style={styles.hit}
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
    alignItems: 'center',
    gap: space.md,
    minHeight: touchTarget,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    flexShrink: 1,
  },
  brand: {
    color: colors.bone,
    fontSize: 20,
    lineHeight: 24,
    fontFamily: fonts.serif,
    letterSpacing: 0.4,
  },
  brandMuted: {
    color: colors.muted,
    fontStyle: 'italic',
    fontFamily: fonts.serif,
  },
  back: {
    color: colors.bone,
    fontSize: 15,
    fontFamily: fonts.sansMedium,
  },
  center: {
    flex: 1,
    textAlign: 'center',
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 16,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    flexShrink: 1,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  help: {
    color: colors.body,
    fontSize: 12,
    fontFamily: fonts.sansSemibold,
  },
  hit: {
    minHeight: touchTarget,
    justifyContent: 'center',
  },
});
