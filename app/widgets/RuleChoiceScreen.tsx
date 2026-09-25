import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { WidgetConfigurationScreenProps } from 'react-native-android-widget';

import { Button } from '../components/Button';
import { colors, fonts, space } from '../components/theme';
import {
  RULE_WIDGET_NAME,
  WIDGET_ERROR_COPY,
  WIDGET_LOADING_COPY,
  describeWidget,
  loadWidgetBoard,
  readWidgetBindings,
  withWidgetBinding,
  writeWidgetBindings,
  type WidgetRuleFace,
} from '../lib/widgetData';
import { HomeWidgetFace } from './HomeWidgetFace';
import { widgetElement } from './androidWidget';

export function RuleChoiceScreen({
  widgetInfo,
  renderWidget,
  setResult,
}: WidgetConfigurationScreenProps) {
  const [status, setStatus] = useState<'loading' | 'empty' | 'error' | 'ready'>('loading');
  const [message, setMessage] = useState(WIDGET_LOADING_COPY);
  const [rules, setRules] = useState<WidgetRuleFace[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    loadWidgetBoard(Date.now())
      .then((board) => {
        if (!alive) {
          return;
        }
        if (board.status === 'ready') {
          setRules(board.rules);
          setStatus('ready');
          return;
        }
        setMessage(board.message);
        setStatus(board.status);
      })
      .catch(() => {
        if (!alive) {
          return;
        }
        setMessage(WIDGET_ERROR_COPY);
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  async function pick(address: string) {
    if (saving || widgetInfo.widgetName !== RULE_WIDGET_NAME) {
      return;
    }
    const face = rules.find((rule) => rule.address === address);
    if (!face) {
      return;
    }
    setSaving(true);
    try {
      const bindings = await readWidgetBindings();
      await writeWidgetBindings(withWidgetBinding(bindings, widgetInfo.widgetId, address));
      renderWidget(widgetElement({ kind: 'rule', face, size: 'small' }));
      setResult('ok');
    } catch {
      setSaving(false);
      setMessage(WIDGET_ERROR_COPY);
      setStatus('error');
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Which rule should this widget show?</Text>
      {status === 'ready' ? (
        <ScrollView contentContainerStyle={styles.list}>
          {rules.map((rule) => (
            <Pressable
              key={rule.address}
              accessibilityRole="button"
              accessibilityLabel={describeWidget(rule, 'small')}
              disabled={saving}
              onPress={() => {
                void pick(rule.address);
              }}
              style={styles.choice}
            >
              <HomeWidgetFace status="ready" size="small" face={rule} />
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <HomeWidgetFace status={status} size="large" message={message} />
      )}
      <Button label="Not now" quiet onPress={() => setResult('cancel')} disabled={saving} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: space.screen,
    gap: space.xl,
  },
  title: {
    fontFamily: fonts.serif,
    fontSize: 22,
    lineHeight: 26,
    color: colors.bone,
  },
  list: {
    gap: space.xl,
    paddingBottom: space.bottom,
  },
  choice: {
    alignSelf: 'stretch',
  },
});
