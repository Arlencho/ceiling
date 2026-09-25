import { redactRpc } from '../../lib/rpcPrivacy';
import { PublicKey } from '@solana/web3.js';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';

import { RenewalScreen } from '../../components/renewal/RenewalScreen';
import { loadAddressBook } from '../../lib/addressBook';
import { createClient, fetchLedger } from '../../lib/chain';
import { networkBadge } from '../../lib/grade';
import { secureStore } from '../../lib/mwa';
import { agentLabel } from '../../lib/quietNote';
import {
  LET_END_KEY,
  LET_END_NOTE,
  buildRenewalView,
  parseLetEnd,
  rememberLetEnd,
  renewalDraftError,
  renewalSearchParams,
  type NextRuleDraft,
} from '../../lib/renewal';
import { useChain } from '../../lib/useChain';

const NOT_ENDING =
  'This rule is not ending in the next seven days. If you do nothing when it does end, what is left goes back to your wallet.';

export default function RenewalRoute() {
  const { address } = useLocalSearchParams<{ address: string }>();
  const chain = useChain();
  const router = useRouter();
  const [names, setNames] = useState<Record<string, string>>({});
  const [letEnds, setLetEnds] = useState<string[]>([]);
  const [letEndNote, setLetEndNote] = useState<string | null>(null);
  const [ledger, setLedger] = useState<{ total: number; rows: { ts: bigint; kind: number; amount: bigint }[] } | null>(
    null,
  );
  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const mandate = address ? (chain.mandates.find((row) => row.address === address) ?? null) : null;
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const cluster = chain.config ? networkBadge(chain.config.explorerCluster, 'tokens') : null;
  const snapshotLedger =
    mandate && chain.snapshot?.mandate === mandate.address && chain.mandate?.address === mandate.address
      ? { total: chain.snapshot.total, rows: chain.rows }
      : null;
  const usingSnapshot = snapshotLedger != null;
  const loadedLedger = snapshotLedger ?? (mandate && ledgerFor === mandate.address ? ledger : null);

  useEffect(() => {
    let cancelled = false;
    void loadAddressBook(secureStore)
      .then((book) => {
        if (!cancelled) {
          setNames(book);
        }
      })
      .catch(() => undefined);
    void secureStore
      .getItem(LET_END_KEY)
      .then((raw) => {
        if (!cancelled) {
          setLetEnds(parseLetEnd(raw));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const remembered = address != null && letEnds.includes(address) ? LET_END_NOTE : null;

  useEffect(() => {
    if (!mandate || !chain.config || usingSnapshot) {
      return;
    }
    let cancelled = false;
    const ruleAddress = mandate.address;
    const client = createClient(chain.config);
    void fetchLedger(client, new PublicKey(ruleAddress))
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setLedger({ total: snapshot.total, rows: snapshot.entries });
        setLedgerFor(ruleAddress);
        setLedgerError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setLedger(null);
        setLedgerFor(ruleAddress);
        setLedgerError(err instanceof Error ? redactRpc(err.message) : 'The decision record could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [mandate, chain.config, usingSnapshot]);

  const view = useMemo(() => {
    if (!mandate || !loadedLedger) {
      return null;
    }
    return buildRenewalView({
      mandate,
      rows: loadedLedger.rows,
      decimals: chain.decimals,
      nowSec,
      agentName: agentLabel(names, mandate.agent, mandate.purpose),
      ledgerTotal: loadedLedger.total,
    });
  }, [mandate, loadedLedger, chain.decimals, nowSec, names]);

  let status: 'loading' | 'empty' | 'error' | 'ready' = 'loading';
  let message: string | null = null;
  if (chain.configError) {
    status = 'error';
    message = chain.configError;
  } else if (chain.mandateStatus === 'failed' || chain.mandateStatus === 'rate-limited') {
    status = 'error';
    message = chain.error ?? 'The rule could not be read.';
  } else if (chain.mandateStatus === 'not-read' || chain.nowMs === 0) {
    status = 'loading';
  } else if (!mandate) {
    status = 'empty';
    message = 'This rule is not on chain for this owner.';
  } else if (!loadedLedger && !ledgerError) {
    status = 'loading';
  } else if (ledgerError && ledgerFor === mandate.address) {
    status = 'error';
    message = ledgerError;
  } else if (!view) {
    status = 'empty';
    message = NOT_ENDING;
  } else {
    status = 'ready';
  }

  const formKey = view
    ? `${view.address}:${view.baseline.expiryDays}:${view.baseline.cap}:${view.baseline.perTxMax}:${view.baseline.merchant}:${view.baseline.purpose}`
    : 'pending';

  return (
    <RenewalScreen
      key={formKey}
      status={status}
      message={message}
      view={status === 'ready' ? view : null}
      decimals={chain.decimals}
      nowSec={nowSec}
      cluster={cluster}
      refreshing={chain.loading}
      letEndNote={letEndNote ?? remembered}
      onClose={() => router.back()}
      onRefresh={() => {
        void chain.refresh();
      }}
      onSetup={(draft: NextRuleDraft) => {
        if (!mandate || renewalDraftError(draft, chain.decimals)) {
          return;
        }
        router.push({
          pathname: '/rule/new',
          params: renewalSearchParams(mandate.address, draft),
        });
      }}
      onLetEnd={() => {
        if (!mandate) {
          return;
        }
        void rememberLetEnd(secureStore, mandate.address)
          .then(() => {
            setLetEndNote(LET_END_NOTE);
          })
          .catch(() => {
            setLetEndNote(LET_END_NOTE);
          });
      }}
    />
  );
}
