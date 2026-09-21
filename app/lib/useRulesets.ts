import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { secureStore } from './mwa';
import {
  addRuleset,
  nextRulesetVersion,
  type Ruleset,
} from './ruleset';
import type { WalletStore } from './wallet';

export const RULESET_STORE_KEY = 'veto.rulesets';

export type RulesetState = {
  ready: boolean;
  rulesets: Ruleset[];
  save: (draft: Omit<Ruleset, 'version'> & { version?: number }) => Promise<Ruleset>;
};

function parseRulesets(raw: string | null): Ruleset[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: Ruleset[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const rec = row as Record<string, unknown>;
      if (
        typeof rec.id === 'string' &&
        typeof rec.name === 'string' &&
        typeof rec.version === 'number' &&
        typeof rec.cap === 'string' &&
        typeof rec.perTxMax === 'string' &&
        typeof rec.expiryDays === 'string' &&
        typeof rec.merchant === 'string' &&
        typeof rec.purpose === 'string'
      ) {
        out.push({
          id: rec.id,
          name: rec.name,
          version: rec.version,
          cap: rec.cap,
          perTxMax: rec.perTxMax,
          expiryDays: rec.expiryDays,
          merchant: rec.merchant,
          purpose: rec.purpose,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function loadRulesets(store: WalletStore): Promise<Ruleset[]> {
  return parseRulesets(await store.getItem(RULESET_STORE_KEY));
}

async function persistRulesets(store: WalletStore, rows: Ruleset[]): Promise<void> {
  await store.setItem(RULESET_STORE_KEY, JSON.stringify(rows));
}

function useRulesetState(): RulesetState {
  const [ready, setReady] = useState(false);
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await loadRulesets(secureStore);
      if (!cancelled) {
        setRulesets(loaded);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (draft: Omit<Ruleset, 'version'> & { version?: number }) => {
    const current = await loadRulesets(secureStore);
    const version = draft.version ?? nextRulesetVersion(current, draft.id);
    const row: Ruleset = { ...draft, version };
    const next = addRuleset(current, row);
    await persistRulesets(secureStore, next);
    setRulesets(next);
    return row;
  }, []);

  return useMemo(
    () => ({
      ready,
      rulesets,
      save,
    }),
    [ready, rulesets, save],
  );
}

const RulesetContext = createContext<RulesetState | null>(null);

export function RulesetProvider({ children }: { children: ReactNode }) {
  const value = useRulesetState();
  return createElement(RulesetContext.Provider, { value }, children);
}

export function useRulesets(): RulesetState {
  const ctx = useContext(RulesetContext);
  if (!ctx) {
    throw new Error('useRulesets must be used within RulesetProvider');
  }
  return ctx;
}
