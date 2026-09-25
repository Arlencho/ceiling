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

export function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  const first = Array.isArray(scheme) ? scheme[0] : scheme;
  return typeof first === 'string' && first.length > 0 ? first : 'veto';
}

export function loadConfig(): AppConfig {
  return configFromExtra(extra(), process.env as Record<string, string | undefined>);
}

export function tryLoadConfig():
  | { ok: true; config: AppConfig }
  | { ok: false; error: string } {
  return tryConfigFromExtra(extra(), process.env as Record<string, string | undefined>);
}
