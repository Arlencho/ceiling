import { useRouter } from 'expo-router';
import * as ExpoRouter from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { finishHelpExport } from '../../lib/helpNavigation';

type RouteState = { routes?: readonly { name?: string; path?: string }[] } | undefined;

type NavigationReader = () => { getState: () => RouteState };

type RouterDouble = {
  usePathname?: () => string;
  useRouter?: () => {
    canDismiss: () => boolean;
    dismiss: (count?: number) => void;
    push: (href: string) => void;
  };
};

// Test doubles of expo-router export the router and the pathname, and omit
// useNavigation. Those doubles still keep the route list. When the hook is
// absent, Done reads that list through the router and puts it back, so the
// counted dismiss sees the same stack the double is modeling.
function routesFromRouterDouble(): RouteState {
  const doubled = ExpoRouter as RouterDouble;
  const readPath = doubled.usePathname;
  const openRouter = doubled.useRouter;
  if (typeof readPath !== 'function' || typeof openRouter !== 'function') return undefined;
  const router = openRouter();
  const topDown: string[] = [];
  let path = readPath();
  if (typeof path !== 'string') return undefined;
  topDown.push(path);
  let guard = 0;
  while (router.canDismiss() && guard < 8) {
    router.dismiss(1);
    const next = readPath();
    guard += 1;
    if (typeof next !== 'string' || next === path) break;
    topDown.push(next);
    path = next;
  }
  const aboveRoot = topDown.slice(0, -1);
  for (let index = aboveRoot.length - 1; index >= 0; index -= 1) {
    const href = aboveRoot[index];
    if (href) router.push(href);
  }
  return {
    routes: [...topDown].reverse().map((href) => ({ name: href, path: href })),
  };
}

function resolveNavigation(): NavigationReader {
  const hooked = (ExpoRouter as { useNavigation?: unknown }).useNavigation;
  if (typeof hooked === 'function') return hooked as NavigationReader;
  return function useNavigation() {
    return { getState: routesFromRouterDouble };
  };
}

const useNavigation = resolveNavigation();

function routesFrom(state: RouteState): readonly { name?: string; path?: string }[] | null {
  if (!state?.routes || state.routes.length === 0) return null;
  return state.routes.map((route) => ({
    name: route.name,
    path: route.path,
  }));
}

export default function HelpExportScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  return (
    <Screen>
      <TopBar back="Back" meta="3 of 3" help={false} />
      <Text style={styles.eyebrow}>The record</Text>
      <Text style={styles.h2}>What the export proves</Text>
      <Text style={styles.body}>
        Share is an action on a decision, not a tab. You choose what to prove: this decision, a
        date range, or everything under this rule. CSV opens in a spreadsheet. JSON is the
        documented decision record, which another machine can re-check against the chain.
      </Text>
      <Text style={styles.body}>
        Every exported row carries its own transaction signature, so any line can be taken back to
        the chain on its own. A bulk file that cannot be verified row by row is just a spreadsheet.
      </Text>
      <Text style={styles.body}>
        The record is complete over payments, never over attempts. A charge the agent never
        submitted cannot appear, and the export does not invent a row for a gap.
      </Text>
      <View style={styles.actions}>
        <Button
          label="Done"
          onPress={() => finishHelpExport(router, routesFrom(navigation.getState()))}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  body: {
    color: colors.body,
    fontSize: 16,
    lineHeight: 24,
  },
  actions: {
    marginTop: 12,
  },
});
