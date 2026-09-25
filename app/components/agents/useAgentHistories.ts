import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { loadAddressBook, saveAddressBook, withSavedName } from '../../lib/addressBook';
import { createClient, fetchLedgerRows, fetchMintDecimals } from '../../lib/chain';
import { STATUS_ACTIVE } from '../../lib/constants';
import { describeAgentRead } from '../../lib/agentRead';
import { buildAgentRecords, type AgentRecord, type GradeDecision, type RuleFacts } from '../../lib/grade';
import { secureStore } from '../../lib/mwa';
import type { LedgerRow } from '../../lib/ring';
import { displayPurpose } from '../../lib/ruleView';
import { useChain } from '../../lib/useChain';

export type AgentScreenData = {
  status: 'loading' | 'empty' | 'error' | 'ready';
  error: string | null;
  notice?: string | null;
  cluster: string;
  rpcUrl: string;
  nowSec: bigint;
  liveRules: number;
  agents: AgentRecord[];
  refreshing: boolean;
  refresh: () => void;
  saveName: (agent: string, name: string) => Promise<void>;
};

function toDecision(row: LedgerRow): GradeDecision {
  return {
    kind: row.kind,
    ts: row.ts,
    amount: row.amount,
    nonce: row.nonce,
    reason: row.reason,
    counterparty: row.counterparty,
  };
}

export function useAgentHistories(): AgentScreenData {
  const chain = useChain();
  const [names, setNames] = useState<Record<string, string>>({});
  const [rules, setRules] = useState<RuleFacts[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const refresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const saveName = useCallback(async (agent: string, name: string) => {
    const book = await loadAddressBook(secureStore);
    const next = withSavedName(book, agent, name);
    await saveAddressBook(secureStore, next);
    setNames(next);
  }, []);

  useEffect(() => {
    let alive = true;
    void loadAddressBook(secureStore)
      .then((book) => {
        if (alive) {
          setNames(book);
        }
      })
      .catch(() => {
        if (alive) {
          setNames({});
        }
      });
    return () => {
      alive = false;
    };
  }, [chain.nowMs]);

  const mandateKey = chain.mandates.map((mandate) => mandate.address).join(',');
  const rowKey = chain.rows.map((row) => `${row.kind}:${row.nonce}:${row.ts}`).join(',');

  useEffect(() => {
    if (!chain.ready || !chain.config || chain.loading || chain.nowMs === 0) {
      return;
    }
    if (chain.mandateStatus === 'not-read' || chain.mandateStatus === 'rate-limited') {
      return;
    }
    if (chain.mandates.length === 0) {
      return;
    }
    const config = chain.config;
    const mandates = chain.mandates;
    const decimals = chain.decimals;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) {
        return;
      }
      setFetching(true);
      try {
        const client = createClient(config);
        const loaded: RuleFacts[] = [];
        for (const mandate of mandates) {
          const ledger = await fetchLedgerRows(
            client,
            new PublicKey(mandate.address),
            new PublicKey(mandate.agent),
          );
          let mintDecimals = decimals;
          try {
            mintDecimals = await fetchMintDecimals(client, new PublicKey(mandate.mint));
          } catch {
            mintDecimals = config.mintDecimals;
          }
          loaded.push({
            address: mandate.address,
            agent: mandate.agent,
            purpose: displayPurpose(mandate.purpose),
            cap: mandate.cap,
            spent: mandate.spent,
            perTxMax: mandate.perTxMax,
            expiresAt: mandate.expiresAt,
            status: mandate.status,
            decimals: mintDecimals,
            rows: ledger.rows.map(toDecision),
          });
        }
        if (!alive) {
          return;
        }
        setRules(loaded);
        setLoadError(null);
      } catch (err) {
        if (!alive) {
          return;
        }
        setRules(null);
        setLoadError(err instanceof Error ? err.message : 'The record could not be read.');
      } finally {
        if (alive) {
          setFetching(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [chain, chain.config, chain.decimals, chain.loading, chain.mandateStatus, chain.nowMs, chain.ready, mandateKey, rowKey]);

  const nowSec = chain.nowMs > 0 ? BigInt(Math.floor(chain.nowMs / 1000)) : 0n;
  const aligned =
    rules != null &&
    chain.mandates.length > 0 &&
    rules.length === chain.mandates.length &&
    chain.mandates.every((mandate) => rules.some((rule) => rule.address === mandate.address))
      ? rules
      : null;
  const agents = useMemo(
    () => (aligned == null || nowSec === 0n ? [] : buildAgentRecords(aligned, names, nowSec)),
    [aligned, names, nowSec],
  );
  const liveRules =
    aligned == null
      ? 0
      : aligned.filter((rule) => rule.status === STATUS_ACTIVE && nowSec < rule.expiresAt).length;

  const described = describeAgentRead({
    configError: chain.configError,
    mandateStatus: chain.mandateStatus,
    chainError: chain.error,
    loadError,
    ready: chain.ready,
    nowMs: chain.nowMs,
    mandateCount: chain.mandates.length,
    historiesReady: aligned != null,
  });

  return {
    status: described.status,
    error: described.error,
    notice: described.notice,
    cluster: chain.config?.explorerCluster ?? 'devnet',
    rpcUrl: chain.config?.rpcUrl ?? '',
    nowSec,
    liveRules,
    agents,
    refreshing: chain.loading || fetching,
    refresh,
    saveName,
  };
}
