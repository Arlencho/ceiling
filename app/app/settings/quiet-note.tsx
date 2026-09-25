import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';

import { QuietNoteScreen } from '../../components/renewal/QuietNoteScreen';
import { loadAddressBook } from '../../lib/addressBook';
import { networkBadge } from '../../lib/grade';
import { isActive } from '../../lib/mandate';
import { secureStore } from '../../lib/mwa';
import { NOTIFICATIONS_OFF_LINE } from '../../lib/notificationAsk';
import {
  agentLabel,
  clockLabel,
  expoQuietScheduler,
  loadQuietSettings,
  quietFire,
  quietNoteCopy,
  refreshQuietNote,
  type QuietNoteCopy,
  type QuietSettings,
} from '../../lib/quietNote';
import { useChain } from '../../lib/useChain';
import { notificationPermissions } from '../../lib/useNotificationOffer';

export default function QuietNoteRoute() {
  const chain = useChain();
  const router = useRouter();
  const [settings, setSettings] = useState<QuietSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mandate = chain.mandate;
  const now = useMemo(() => (chain.nowMs > 0 ? new Date(chain.nowMs) : new Date()), [chain.nowMs]);
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  const cluster = chain.config ? networkBadge(chain.config.explorerCluster, 'tokens') : null;
  const live = mandate != null && isActive(mandate, nowSec);

  useEffect(() => {
    let cancelled = false;
    void loadQuietSettings(secureStore)
      .then((loaded) => {
        if (!cancelled) {
          setSettings(loaded);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSettingsError(err instanceof Error ? err.message : 'The quiet note settings could not be read.');
        }
      });
    void loadAddressBook(secureStore)
      .then((book) => {
        if (!cancelled) {
          setNames(book);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const copy: QuietNoteCopy | null = useMemo(() => {
    if (!mandate || !live) {
      return null;
    }
    return quietNoteCopy({
      name: agentLabel(names, mandate.agent, mandate.purpose),
      cap: mandate.cap,
      spent: mandate.spent,
      expiresAt: mandate.expiresAt,
      decimals: chain.decimals,
      rows: chain.rows,
      ledgerTotal: chain.snapshot?.total ?? null,
      now,
    });
  }, [mandate, live, names, chain.decimals, chain.rows, chain.snapshot?.total, now]);

  let status: 'loading' | 'empty' | 'error' | 'ready' = 'loading';
  let message: string | null = null;
  if (chain.configError) {
    status = 'error';
    message = chain.configError;
  } else if (chain.mandateStatus === 'failed' || chain.mandateStatus === 'rate-limited') {
    status = 'error';
    message = chain.error ?? "Today's decisions could not be read.";
  } else if (settingsError) {
    status = 'error';
    message = settingsError;
  } else if (chain.mandateStatus === 'not-read' || chain.nowMs === 0 || settings == null) {
    status = 'loading';
  } else if (!live || !mandate || !copy) {
    status = 'empty';
  } else {
    status = 'ready';
  }

  const formKey = settings
    ? `${settings.enabled ? '1' : '0'}:${settings.send}:${settings.hour}:${settings.minute}`
    : 'pending';

  return (
    <QuietNoteScreen
      key={formKey}
      status={status}
      message={message}
      settings={settings}
      copy={status === 'ready' ? copy : null}
      cluster={cluster}
      saving={saving}
      notice={notice}
      onBack={() => router.back()}
      onSave={(next) => {
        if (!mandate) {
          return;
        }
        setSaving(true);
        setNotice(null);
        void (async () => {
          try {
            let granted = false;
            if (next.enabled) {
              const reader = await notificationPermissions.load();
              const current = await reader.getPermissionsAsync();
              const result = current.granted ? current : await reader.requestPermissionsAsync();
              granted = result.granted === true;
            }
            await refreshQuietNote({
              mandates: [mandate],
              ledgers: [
                {
                  mandate: mandate.address,
                  rows: chain.rows,
                  total: chain.snapshot?.total ?? null,
                  decimals: chain.decimals,
                },
              ],
              now: new Date(),
              selectedAddress: mandate.address,
              store: secureStore,
              scheduler: await expoQuietScheduler(),
              permissionGranted: granted,
              settingsOverride: next,
            });
            setSettings(await loadQuietSettings(secureStore));
            if (granted) {
              try {
                const task = await import('../../lib/decisionNotifyTask');
                await task.scanDecisionsIfAllowed();
              } catch {
                // The note for the chosen time is already scheduled from the decisions just read.
              }
            }
            if (!next.enabled) {
              setNotice('The quiet note stays off. Nothing was scheduled.');
            } else if (!granted) {
              setNotice(NOTIFICATIONS_OFF_LINE);
            } else {
              const when = clockLabel(quietFire(new Date(), next.hour, next.minute));
              setNotice(`The quiet note is set for ${when}.`);
            }
          } catch (err) {
            setNotice(err instanceof Error ? err.message : 'The quiet note could not be saved.');
          } finally {
            setSaving(false);
          }
        })();
      }}
    />
  );
}
