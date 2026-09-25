import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { QuietReading, quietRefreshControl } from './QuietRefresh';
import { colors, space } from './theme';

export function Screen({
  children,
  header,
  scroll = true,
  refreshing = false,
  onRefresh,
}: {
  children: ReactNode;
  header?: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const body = (
    <View style={styles.content}>
      {header}
      {scroll ? <QuietReading busy={refreshing} /> : null}
      {children}
    </View>
  );
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.grow}
          keyboardShouldPersistTaps="handled"
          refreshControl={quietRefreshControl(onRefresh)}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  grow: {
    flexGrow: 1,
  },
  content: {
    paddingHorizontal: space.screen,
    paddingTop: space.xxxl,
    paddingBottom: space.bottom,
    gap: space.xl,
    flexGrow: 1,
  },
});
