import { StyleSheet, Text, View } from 'react-native';

import { BlockBar } from '../components/backglass/BlockBar';
import { BrassFrame } from '../components/backglass/BrassFrame';
import { CatchMark } from '../components/backglass/CatchMark';
import { Lamp } from '../components/backglass/Lamp';
import { colors, fonts, space } from '../components/theme';
import {
  WIDGET_LOADING_COPY,
  describeWidget,
  type WidgetRuleFace,
} from '../lib/widgetData';

export function HomeWidgetFace({
  status,
  size,
  face = null,
  message = '',
}: {
  status: 'loading' | 'empty' | 'error' | 'ready';
  size: 'large' | 'small';
  face?: WidgetRuleFace | null;
  message?: string;
}) {
  const ready = status === 'ready' && face != null;
  const body = status === 'loading' ? WIDGET_LOADING_COPY : message;
  const label = ready && face ? describeWidget(face, size) : `Veto widget. ${body}`;
  return (
    <BrassFrame padding={size === 'large' ? 12 : 10} accessibilityLabel={label}>
      <View
        testID="widget-face"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.stack}
      >
        <View style={styles.header}>
          <CatchMark size={size === 'large' ? 16 : 12} />
          <Text style={styles.kicker} numberOfLines={3}>
            {ready && face ? face.heading : 'Veto'}
          </Text>
          {ready && face && size === 'large' ? (
            <View style={styles.live}>
              {face.live ? (
                <Lamp state="on" litColor={colors.paid} size={7} accessibilityLabel="Rule live" />
              ) : null}
              <Text style={[styles.liveText, face.live ? styles.liveOn : null]}>{face.statusLine}</Text>
            </View>
          ) : null}
        </View>
        {ready && face ? <ReadyFace face={face} size={size} /> : <Text style={styles.message}>{body}</Text>}
      </View>
    </BrassFrame>
  );
}

function ReadyFace({ face, size }: { face: WidgetRuleFace; size: 'large' | 'small' }) {
  const large = size === 'large';
  return (
    <View style={styles.stack}>
      <View style={styles.figureRow}>
        <Text style={[styles.figure, !large && styles.figureSmall]}>{face.remainingText}</Text>
        <Text style={[styles.of, !large && styles.ofSmall]}>of {face.capText}</Text>
        {large ? (
          <View style={styles.days}>
            <Text style={styles.daysValue}>{face.daysLeft}</Text>
            <Text style={styles.daysEnds}>{face.ends}</Text>
          </View>
        ) : null}
      </View>
      {large ? (
        <BlockBar
          remaining={face.barRemaining}
          cap={face.barCap}
          accessibilityLabel={`${face.remainingText} remaining of ${face.capText}`}
        />
      ) : null}
      <View style={[styles.split, !large && styles.splitQuiet]}>
        <Text style={styles.decision}>{large ? face.decisionLine : face.decisionShort}</Text>
        {large ? <Text style={styles.tally}>{face.tally}</Text> : null}
      </View>
      <Text style={styles.updated}>{face.updatedLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: space.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  kicker: {
    flex: 1,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveText: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  liveOn: {
    color: colors.paid,
  },
  figureRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.md,
  },
  figure: {
    fontFamily: fonts.serifLight,
    fontSize: 48,
    lineHeight: 48,
    color: colors.bone,
  },
  figureSmall: {
    fontSize: 32,
    lineHeight: 32,
  },
  of: {
    fontFamily: fonts.serifLight,
    fontSize: 18,
    lineHeight: 22,
    color: colors.muted,
    marginBottom: 4,
  },
  ofSmall: {
    fontSize: 14,
    lineHeight: 18,
    marginBottom: 2,
  },
  days: {
    marginLeft: 'auto',
    alignItems: 'flex-end',
  },
  daysValue: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.body,
    textAlign: 'right',
  },
  daysEnds: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
    textAlign: 'right',
  },
  split: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
    paddingTop: space.sm,
  },
  splitQuiet: {
    borderTopWidth: 0,
    paddingTop: 0,
  },
  decision: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.body,
  },
  tally: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  updated: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 14,
    color: colors.muted,
  },
  message: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
  },
});
