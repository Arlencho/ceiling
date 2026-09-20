import Constants from 'expo-constants';

import { configFromExtra, tryConfigFromExtra, type AppConfig } from './appConfig';

export type { AppConfig } from './appConfig';
export { configFromExtra, tryConfigFromExtra };

function extra(): Record<string, unknown> {
  const fromExpo = Constants.expoConfig?.extra;
  if (fromExpo && typeof fromExpo === 'object') {
    return fromExpo as Record<string, unknown>;
  }
  return {};
}

export function loadConfig(): AppConfig {
  return configFromExtra(extra(), process.env as Record<string, string | undefined>);
}

export function tryLoadConfig():
  | { ok: true; config: AppConfig }
  | { ok: false; error: string } {
  return tryConfigFromExtra(extra(), process.env as Record<string, string | undefined>);
}
