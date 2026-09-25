import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import {
  QUIET_NOTE_CAPTION,
  QUIET_NOTE_HONEST,
  QUIET_NOTE_INTRO,
  QUIET_SEND_OPTIONS,
  clockLabel,
  quietActionLabel,
  shiftClock,
  type QuietNoteCopy,
  type QuietSend,
  type QuietSettings,
} from '../../lib/quietNote';
import { CatchMark } from '../backglass/CatchMark';
import { Lamp } from '../backglass/Lamp';
import { colors, fonts, radii, space, touchTarget } from '../theme';
import { RenewalHeader, RenewalShell, StatusLine } from './shell';

export function QuietNoteScreen({
  status,
  message,
  settings,
  copy,
  cluster,
  saving,
  notice,
  onBack,
  onSave,
}: {
  status: 'loading' | 'empty' | 'error' | 'ready';
  message: string | null;
  settings: QuietSettings | null;
  copy: QuietNoteCopy | null;
  cluster: string | null;
  saving?: boolean;
  notice: string | null;
  onBack: () => void;
  onSave: (next: QuietSettings) => void;
}) {
  const [send, setSend] = useState<QuietSend>(settings?.send ?? 'every-evening');
  const [hour, setHour] = useState(settings?.hour ?? 21);
  const [minute, setMinute] = useState(settings?.minute ?? 0);
  const [picking, setPicking] = useState(false);
  const enabled = settings?.enabled === true;
  const timeLabel = clockLabel(new Date(2026, 0, 1, hour, minute, 0, 0));
  const silent = send === 'moved' && copy != null && !copy.moved;

  return (
    <RenewalShell>
      <RenewalHeader title="Alerts" backLabel="Back to alerts" onBack={onBack} icon="back" cluster={cluster} />
      <View style={styles.body}>
        <Text style={styles.kicker}>A quiet note each day</Text>
        <Text style={styles.h1}>Hear that all is well, once a day.</Text>
        <Text style={styles.intro}>{QUIET_NOTE_INTRO}</Text>

        {status === 'loading' ? <StatusLine>Reading decisions from today.</StatusLine> : null}
        {status === 'error' ? <StatusLine>{message ?? "Today's decisions could not be read."}</StatusLine> : null}
        {status === 'empty' ? (
          <StatusLine>There is no live rule to write a note about. The quiet note stays off.</StatusLine>
        ) : null}

        {status === 'ready' && copy ? (
          <View style={styles.previewWrap}>
            <View
              accessibilityLabel={`Example note. Veto, ${timeLabel}. ${copy.headline} ${copy.detail}`}
              style={styles.preview}
            >
              <View style={styles.mark}>
                <CatchMark size={20} />
                <View style={styles.lamp}>
                  <Lamp state="pulse" size={8} litColor={colors.paid} accessibilityLabel="Rule still live" />
                </View>
              </View>
              <View style={styles.previewCopy}>
                <View style={styles.previewHead}>
                  <Text style={styles.previewBrand}>Veto</Text>
                  <Text style={styles.previewTime}>{timeLabel}</Text>
                </View>
                <Text style={styles.previewHeadline}>{copy.headline}</Text>
                <Text style={styles.previewDetail}>{copy.detail}</Text>
              </View>
            </View>
            <Text style={styles.caption}>{QUIET_NOTE_CAPTION}</Text>
            {silent ? (
              <Text style={styles.caption}>Tonight it would stay silent.</Text>
            ) : null}
          </View>
        ) : null}

        {status === 'ready' && settings ? (
          <View style={styles.options}>
            <Text style={styles.section}>When to send it</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="When to send the quiet note" style={styles.group}>
              {QUIET_SEND_OPTIONS.map((option) => {
                const selected = send === option.id;
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="radio"
                    accessibilityLabel={option.title}
                    accessibilityState={{ selected }}
                    onPress={() => setSend(option.id)}
                    style={[styles.opt, selected && styles.optOn]}
                  >
                    <View style={[styles.radio, selected && styles.radioOn]}>
                      {selected ? <View style={styles.dot} /> : null}
                    </View>
                    <View style={styles.optCopy}>
                      <Text style={styles.optTitle}>{option.title}</Text>
                      {option.detail ? <Text style={styles.optDetail}>{option.detail}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.timeRow}>
              <Text style={styles.timeK}>At what time</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Change the time"
                onPress={() => setPicking((open) => !open)}
                style={styles.timeHit}
              >
                <Text style={styles.timeV}>{timeLabel}</Text>
                <Text style={styles.timeChange}>Change</Text>
              </Pressable>
            </View>
            {picking ? (
              <View style={styles.picker}>
                <Step
                  label="hour"
                  value={hour}
                  onDown={() => {
                    const next = shiftClock(hour, minute, -60);
                    setHour(next.hour);
                    setMinute(next.minute);
                  }}
                  onUp={() => {
                    const next = shiftClock(hour, minute, 60);
                    setHour(next.hour);
                    setMinute(next.minute);
                  }}
                />
                <Step
                  label="minute"
                  value={minute}
                  onDown={() => {
                    const next = shiftClock(hour, minute, -5);
                    setHour(next.hour);
                    setMinute(next.minute);
                  }}
                  onUp={() => {
                    const next = shiftClock(hour, minute, 5);
                    setHour(next.hour);
                    setMinute(next.minute);
                  }}
                />
              </View>
            ) : null}
            {enabled ? <Text style={styles.on}>The quiet note is on.</Text> : null}
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            <View style={styles.spacer} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={quietActionLabel(send, enabled)}
              disabled={saving}
              onPress={() => {
                if (!settings) {
                  return;
                }
                onSave({
                  ...settings,
                  enabled: send !== 'never',
                  send,
                  hour,
                  minute,
                });
              }}
              style={styles.brass}
            >
              <Svg width={18} height={18} viewBox="0 0 24 24">
                <Path
                  d="M20 6L9 17l-5-5"
                  fill="none"
                  stroke={colors.forest}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
              <Text style={styles.brassText}>{quietActionLabel(send, enabled)}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={onBack} style={styles.notNow}>
              <Text style={styles.notNowText}>Not now</Text>
            </Pressable>
          </View>
        ) : null}
        <Text style={styles.honest}>{QUIET_NOTE_HONEST}</Text>
      </View>
    </RenewalShell>
  );
}

function Step({
  label,
  value,
  onDown,
  onUp,
}: {
  label: 'hour' | 'minute';
  value: number;
  onDown: () => void;
  onUp: () => void;
}) {
  const earlier = label === 'hour' ? 'Earlier hour' : 'Earlier minute';
  const later = label === 'hour' ? 'Later hour' : 'Later minute';
  return (
    <View style={styles.step}>
      <Pressable accessibilityRole="button" accessibilityLabel={earlier} onPress={onDown} style={styles.stepHit}>
        <Text style={styles.stepMark}>-</Text>
      </Pressable>
      <Text style={styles.stepValue}>{String(value).padStart(2, '0')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={later} onPress={onUp} style={styles.stepHit}>
        <Text style={styles.stepMark}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: space.screen,
    paddingTop: space.lg,
    gap: space.md,
    flexGrow: 1,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  h1: {
    fontFamily: fonts.serifRegular,
    fontSize: 34,
    lineHeight: 37,
    color: colors.bone,
  },
  intro: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    color: colors.body,
  },
  previewWrap: {
    gap: space.md,
    marginTop: space.md,
  },
  preview: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xl,
    paddingVertical: space.xl,
    paddingHorizontal: space.xxl,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(156, 201, 168, 0.40)',
  },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.brassLine,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lamp: {
    position: 'absolute',
    top: -3,
    right: -3,
  },
  previewCopy: {
    flex: 1,
    gap: 3,
  },
  previewHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
  },
  previewBrand: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  previewTime: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 14,
    color: colors.muted,
  },
  previewHeadline: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.bone,
  },
  previewDetail: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  caption: {
    textAlign: 'center',
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  options: {
    gap: space.md,
    marginTop: space.md,
  },
  section: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  group: {
    gap: space.md,
  },
  opt: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    paddingVertical: space.md,
    paddingHorizontal: space.xxl,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  optOn: {
    borderColor: colors.brass,
    backgroundColor: colors.brassWash,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(237, 230, 214, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: {
    borderColor: colors.brass,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.brass,
  },
  optCopy: {
    flex: 1,
    gap: 2,
  },
  optTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  optDetail: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  timeRow: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xxl,
    borderRadius: radii.plaque,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  timeK: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.muted,
  },
  timeHit: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  timeV: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  timeChange: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 16,
    color: colors.brass,
  },
  picker: {
    flexDirection: 'row',
    gap: space.md,
  },
  step: {
    flex: 1,
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radii.plaque,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  stepHit: {
    minWidth: touchTarget,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepMark: {
    fontFamily: fonts.sansBold,
    fontSize: 18,
    color: colors.brass,
  },
  stepValue: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.bone,
  },
  on: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.paid,
  },
  notice: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  spacer: {
    flexGrow: 1,
    minHeight: space.md,
  },
  brass: {
    height: 54,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  brassText: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 20,
    color: colors.forest,
  },
  notNow: {
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notNowText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.muted,
  },
  honest: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    textAlign: 'center',
    paddingBottom: space.xl,
  },
});
