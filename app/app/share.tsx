import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { Button } from '../components/Button';
import { ConnectGate } from '../components/ConnectGate';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { ReadState } from '../components/ReadState';
import { Screen } from '../components/Screen';
import { TopBar } from '../components/TopBar';
import { colors, fonts } from '../components/theme';
import { KIND_PAID, KIND_REFUSED } from '../lib/constants';
import {
  COMPLETENESS_NOTE,
  formatExport,
  loadedRuleMatchesDecision,
  parseDayBound,
  parseDecisionId,
  rowToExportable,
  selectExportRows,
  signedExportRows,
  type ChargeKind,
  type ShareScope,
} from '../lib/exportRecord';
import { mayClaimAbsence } from '../lib/mandateRead';
import { displayPurpose } from '../lib/ruleView';
import { useChain } from '../lib/useChain';

type Shape = 'csv' | 'json';
type ScopeChoice = 'decision' | 'date_range' | 'rule';

function utcDay(ms: number): string {
  const date = new Date(ms);
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function ShareScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ? decodeURIComponent(rawId) : '';
  const parsed = id ? parseDecisionId(id) : null;
  const chain = useChain();
  const mandate = chain.mandate;
  const kind: ChargeKind | null =
    parsed?.kind === KIND_PAID ? 'paid' : parsed?.kind === KIND_REFUSED ? 'refused' : null;
  const [choice, setChoice] = useState<ScopeChoice>(kind ? 'decision' : 'rule');
  const [shape, setShape] = useState<Shape>('csv');
  const [fromDay, setFromDay] = useState(() => utcDay(Date.now()));
  const [toDay, setToDay] = useState(() => utcDay(Date.now()));
  const [error, setError] = useState<string | null>(null);

  const exportable = useMemo(() => {
    if (!mandate) {
      return [];
    }
    if (!loadedRuleMatchesDecision(mandate.address, parsed?.mandate ?? null)) {
      return [];
    }
    return chain.rows
      .map((row) => rowToExportable(row, mandate.address))
      .filter((row): row is NonNullable<typeof row> => row != null);
  }, [chain.rows, mandate, parsed]);

  const scope: ShareScope | null = useMemo(() => {
    if (choice === 'decision') {
      if (!parsed || !kind) {
        return null;
      }
      return { type: 'decision', nonce: parsed.nonce, kind, timestamp: parsed.ts };
    }
    if (choice === 'date_range') {
      try {
        return {
          type: 'date_range',
          from: parseDayBound(fromDay, false),
          to: parseDayBound(toDay, true),
        };
      } catch {
        return null;
      }
    }
    return { type: 'rule' };
  }, [choice, fromDay, kind, parsed, toDay]);

  const selected = scope ? selectExportRows(exportable, scope) : [];
  const signed = signedExportRows(selected);
  const count = signed.length;

  const onExport = async () => {
    setError(null);
    try {
      if (!mandate || !chain.config) {
        throw new Error(chain.configError ?? 'Config is missing');
      }
      if (!chain.genesisHash) {
        throw new Error('Genesis hash has not been read from this RPC yet. Pull to retry.');
      }
      if (!scope) {
        throw new Error('Choose a scope the export can name.');
      }
      const body = formatExport({
        rows: exportable,
        scope,
        shape,
        ctx: {
          cluster: chain.config.explorerCluster,
          genesisHash: chain.genesisHash,
          programId: chain.config.programId,
          mandate,
        },
      });
      await Share.share({
        message: body,
        title: shape === 'csv' ? 'Veto decisions.csv' : 'Veto decisions.json',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    }
  };

  return (
    <Screen>
      <TopBar back="Decisions" meta={mandate ? displayPurpose(mandate.purpose) : undefined} />
      <ConnectGate>
        {!mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={chain.mandateStatus}
            empty="No rule is selected. Switch on the Rules tab first."
          />
        ) : !mandate ? (
          <EmptyState>No rule is selected. Switch on the Rules tab first.</EmptyState>
        ) : (
          <View style={styles.block}>
            <Text style={styles.h2}>What do you want to prove?</Text>
            <View style={styles.opts}>
              <Opt
                on={choice === 'decision'}
                title="This decision"
                hint={
                  kind
                    ? 'One answer, its rule and its proof.'
                    : 'Export is complete over paid and refused charges. An override is listed in the app and is not this file.'
                }
                count={choice === 'decision' ? `${count} row` : '1 row'}
                onPress={() => {
                  if (kind) {
                    setChoice('decision');
                  }
                }}
              />
              <Opt
                on={choice === 'date_range'}
                title="A date range"
                hint="A period under review, UTC calendar days."
                count={`${choice === 'date_range' ? count : ''} rows`}
                onPress={() => setChoice('date_range')}
              />
              <Opt
                on={choice === 'rule'}
                title="Everything under this rule"
                hint="The complete record this phone can rebuild from the ring and logs."
                count={`${choice === 'rule' ? count : exportable.length} rows`}
                onPress={() => setChoice('rule')}
              />
            </View>

            {choice === 'date_range' ? (
              <View style={styles.dates}>
                <Field label="From (UTC)" value={fromDay} onChangeText={setFromDay} placeholder="YYYY-MM-DD" />
                <Field label="To (UTC)" value={toDay} onChangeText={setToDay} placeholder="YYYY-MM-DD" />
              </View>
            ) : null}

            <Text style={styles.eyebrow}>Who reads it</Text>
            <View style={styles.two}>
              <Opt
                on={shape === 'csv'}
                title="A person · CSV"
                hint="Opens in a spreadsheet. Sort it, total it."
                onPress={() => setShape('csv')}
              />
              <Opt
                on={shape === 'json'}
                title="A system · JSON"
                hint="The documented record. verify.ts re-checks it."
                onPress={() => setShape('json')}
              />
            </View>

            <Text style={styles.limit}>
              <Text style={styles.bold}>Complete over payments, never over attempts. </Text>
              {COMPLETENESS_NOTE} Every exported row carries its own transaction signature. A row
              this RPC did not sign is omitted rather than invented.
            </Text>

            <Button
              label={
                shape === 'csv'
                  ? `Export ${count} row${count === 1 ? '' : 's'} as CSV`
                  : `Export ${count} row${count === 1 ? '' : 's'} as JSON`
              }
              onPress={() => {
                void onExport();
              }}
            />
            {error ? <Text style={styles.err}>{error}</Text> : null}
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

function Opt({
  on,
  title,
  hint,
  count,
  onPress,
}: {
  on: boolean;
  title: string;
  hint: string;
  count?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.opt, on && styles.optOn]}
    >
      <View style={[styles.dot, on && styles.dotOn]} />
      <View style={styles.optText}>
        <Text style={[styles.optTitle, on && styles.optOnText]}>{title}</Text>
        <Text style={[styles.optHint, on && styles.optOnHint]}>{hint}</Text>
      </View>
      {count ? <Text style={[styles.optCount, on && styles.optOnText]}>{count}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 12,
    alignSelf: 'stretch',
  },
  h2: {
    color: colors.text,
    fontSize: 28,
    fontFamily: fonts.serif,
  },
  opts: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 6,
    overflow: 'hidden',
  },
  two: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 6,
    overflow: 'hidden',
  },
  opt: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 48,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    flex: 1,
  },
  optOn: {
    backgroundColor: colors.invert,
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.muted,
    marginTop: 2,
  },
  dotOn: {
    borderColor: colors.invertText,
    backgroundColor: colors.invertText,
  },
  optText: {
    flex: 1,
  },
  optTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  optHint: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '500',
    marginTop: 2,
    lineHeight: 17,
  },
  optCount: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
    fontFamily: fonts.mono,
  },
  optOnText: {
    color: colors.invertText,
  },
  optOnHint: {
    color: colors.inkOnBone,
  },
  dates: {
    gap: 10,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
  limit: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  bold: {
    color: colors.body,
    fontWeight: '600',
  },
  err: {
    color: colors.body,
    fontSize: 14,
    lineHeight: 20,
  },
});
