// Haptics are a courtesy, never a requirement. The module is loaded on first
// use and every call swallows its own failure, so a phone without a vibrator,
// a build without the native module, or a test without a mock all behave the
// same as a silent success.

type HapticsModule = typeof import('expo-haptics');

let loading: Promise<HapticsModule | null> | null = null;
const pending = new Set<Promise<void>>();

function loadHaptics(): Promise<HapticsModule | null> {
  if (!loading) {
    // Keep native module resolution on the same path as other Expo modules.
    // A dynamic import of Expo's TypeScript entry bypasses module mocks on
    // Node 22 and can cache a failed native load for the whole session.
    loading = Promise.resolve()
      // Native resolution must stay lazy so missing modules remain harmless.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .then(() => require('expo-haptics') as HapticsModule)
      .catch(() => null);
  }
  return loading;
}

function run(fire: (haptics: HapticsModule) => Promise<unknown>): void {
  const job = loadHaptics()
    .then((haptics) => (haptics ? fire(haptics) : undefined))
    .then(
      () => undefined,
      () => undefined,
    );
  pending.add(job);
  void job.finally(() => pending.delete(job));
}

/** Loads the module ahead of the first press so the first touch is not late. */
export function preloadHaptics(): void {
  void loadHaptics();
}

export function pressHaptic(): void {
  run((h) => h.impactAsync(h.ImpactFeedbackStyle.Light));
}

export function tickHaptic(): void {
  run((h) => h.selectionAsync());
}

export function successHaptic(): void {
  run((h) => h.notificationAsync(h.NotificationFeedbackType.Success));
}

/** Resolves once every haptic asked for so far has fired or failed. */
export async function hapticsSettled(): Promise<void> {
  await loadHaptics();
  await Promise.all([...pending]);
}
