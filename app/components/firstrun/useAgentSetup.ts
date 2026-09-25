import { redactRpc } from '../../lib/rpcPrivacy';
import { PublicKey } from '@solana/web3.js';
import { useEffect, useState } from 'react';

import {
  agentChargeConfig,
  agentChargeConfigJson,
  agentChargeRows,
  agentConnectStatus,
  payeeLookup,
  readPayeeTokenAccount,
} from '../../lib/agentConnect';
import { createClient, readRuleFunds } from '../../lib/chain';
import { isActive, type MandateAccount } from '../../lib/mandate';
import { useChain } from '../../lib/useChain';
import type { ScreenView } from './Chrome';

export type AgentSetupState = {
  view: ScreenView;
  rows: { label: string; value: string }[];
  configJson: string | null;
  status: string | null;
  error: string | null;
};

const IDLE: AgentSetupState = {
  view: 'empty',
  rows: [],
  configJson: null,
  status: null,
  error: null,
};

export function useAgentSetup(mandate: MandateAccount | null): AgentSetupState {
  const chain = useChain();
  const [state, setState] = useState<AgentSetupState>(IDLE);

  useEffect(() => {
    if (!mandate) {
      return;
    }
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setState({ ...IDLE, view: 'loading' });
      }
    });
    void (async () => {
      try {
        if (!chain.config) {
          if (!cancelled) {
            setState({
              ...IDLE,
              view: 'error',
              error: chain.configError ?? 'This app has no network configured.',
            });
          }
          return;
        }
        const client = createClient(chain.config);
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        const active = isActive(mandate, nowSec);
        let funds: Awaited<ReturnType<typeof readRuleFunds>> | null = null;
        let fundsError: string | null = null;
        try {
          funds = await readRuleFunds(client, mandate);
        } catch (err) {
          fundsError = err instanceof Error ? redactRpc(err.message) : 'Could not read the rule.';
        }
        let payee: string | null = null;
        let payeeProblem: string | null = null;
        if (funds?.tokenProgram) {
          try {
            const key = await readPayeeTokenAccount(
              payeeLookup(client.connection),
              new PublicKey(mandate.merchant),
              new PublicKey(mandate.mint),
              new PublicKey(funds.tokenProgram),
            );
            payee = key.toBase58();
          } catch (err) {
            payeeProblem = err instanceof Error ? redactRpc(err.message) : 'Could not read the payee token account';
          }
        }
        const config =
          active && funds && funds.decimals != null && payee
            ? agentChargeConfig({
                mandate: mandate.address,
                programId: chain.config.programId,
                mint: mandate.mint,
                mintDecimals: funds.decimals,
                sourceTokenAccount: mandate.source,
                payeeTokenAccount: payee,
                agent: mandate.agent,
                cluster: chain.config.explorerCluster,
                rpcUrl: chain.config.rpcUrl,
              })
            : null;
        const status = agentConnectStatus({
          active,
          ready: config !== null,
          decimalsMissing: Boolean(funds && funds.decimals == null),
          payeeProblem,
          fundsError,
          fundsLoaded: funds !== null,
          configProblem: null,
        });
        if (!cancelled) {
          setState({
            view: 'normal',
            rows: config ? agentChargeRows(config) : [],
            configJson: config ? agentChargeConfigJson(config) : null,
            status,
            error: null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            ...IDLE,
            view: 'error',
            error: err instanceof Error ? redactRpc(err.message) : 'Could not prepare the setup.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chain.config, chain.configError, mandate]);

  if (!mandate) {
    return IDLE;
  }
  return state;
}
