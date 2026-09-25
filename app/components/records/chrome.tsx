import { useEffect, useState, type ReactNode } from 'react';
import * as RN from 'react-native';

import { colors, fonts, radii, touchTarget, type as typeScale } from '../theme';
import { clusterPillLabel } from './copy';

type Reduced = boolean | null;

function useSafeReducedMotion(): Reduced {
  const [reduced, setReduced] = useState<Reduced>(null);

  useEffect(() => {
    const info = RN.AccessibilityInfo;
    if (!info?.isReduceMotionEnabled) {
      return;
    }
    let alive = true;
    const apply = (value: boolean) => {
      if (alive) {
        setReduced(value);
      }
    };
    Promise.resolve(info.isReduceMotionEnabled())
      .then(apply)
      .catch(() => apply(false));
    const subscription = info.addEventListener?.('reduceMotionChanged', apply);
    return () => {
      alive = false;
      subscription?.remove?.();
    };
  }, []);

  return reduced;
}

export function Rise({ delayMs = 0, children }: { delayMs?: number; children: ReactNode }) {
  const reduced = useSafeReducedMotion();
  const Animated = RN.Animated;
  const motionOn = reduced === false && Animated != null;
  const [progress] = useState(() => (Animated ? new Animated.Value(1) : null));

  useEffect(() => {
    if (!motionOn || !Animated || !progress) {
      return;
    }
    progress.setValue(0);
    const easing = RN.Easing?.bezier ? RN.Easing.bezier(0.22, 1, 0.36, 1) : undefined;
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 700,
      delay: delayMs,
      easing,
      useNativeDriver: true,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [Animated, delayMs, motionOn, progress]);

  if (!Animated?.View || !progress) {
    return <RN.View>{children}</RN.View>;
  }
  const translateY = progress.interpolate?.({
    inputRange: [0, 1],
    outputRange: [14, 0],
  });
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: translateY ? [{ translateY }] : undefined,
      }}
    >
      {children}
    </Animated.View>
  );
}

export function Glow() {
  return <RN.View pointerEvents="none" style={styles.glow} />;
}

export function ClusterPill({ cluster }: { cluster: string | null | undefined }) {
  return <RN.Text style={styles.cluster}>{clusterPillLabel(cluster)}</RN.Text>;
}

export function ScreenHeader({
  title,
  cluster,
  onBack,
  backLabel = 'Back',
  onHelp,
}: {
  title: string;
  cluster: string | null | undefined;
  onBack: () => void;
  backLabel?: string;
  onHelp?: () => void;
}) {
  return (
    <RN.View style={styles.header}>
      <RN.Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack}
        hitSlop={8}
        style={styles.hit}
      >
        <RN.Text style={styles.backMark}>{backLabel === 'Back' ? '×' : '‹'}</RN.Text>
      </RN.Pressable>
      <RN.Text style={styles.headerTitle}>{title}</RN.Text>
      <RN.View style={styles.headerEnd}>
        {onHelp ? (
          <RN.Pressable
            accessibilityRole="button"
            accessibilityLabel="Help"
            onPress={onHelp}
            style={styles.hit}
          >
            <RN.Text style={styles.help}>Help</RN.Text>
          </RN.Pressable>
        ) : null}
        <ClusterPill cluster={cluster} />
      </RN.View>
    </RN.View>
  );
}

export function BrassWell({ children, lamps = false }: { children: ReactNode; lamps?: boolean }) {
  return (
    <RN.View style={styles.well}>
      {lamps ? (
        <RN.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.lamps}>
          {Array.from({ length: 10 }, (_, index) => (
            <RN.View key={index} style={styles.lamp} />
          ))}
        </RN.View>
      ) : null}
      {children}
    </RN.View>
  );
}

export function Kicker({ children, aside }: { children: string; aside?: string }) {
  return (
    <RN.View style={styles.kickerRow}>
      <RN.Text style={styles.kicker}>{children}</RN.Text>
      {aside ? <RN.Text style={styles.aside}>{aside}</RN.Text> : null}
    </RN.View>
  );
}

const MARK_COLOR: Record<string, { border: string; wash: string; glyph: string }> = {
  brass: { border: 'rgba(201, 162, 77, 0.45)', wash: 'rgba(201, 162, 77, 0.10)', glyph: colors.brass },
  refused: { border: 'rgba(228, 164, 142, 0.45)', wash: 'rgba(228, 164, 142, 0.10)', glyph: colors.refused },
  paid: { border: 'rgba(156, 201, 168, 0.45)', wash: 'rgba(156, 201, 168, 0.10)', glyph: colors.paid },
  bone: { border: 'rgba(237, 230, 214, 0.22)', wash: 'rgba(237, 230, 214, 0.06)', glyph: colors.body },
};

export function TopicRow({
  title,
  body,
  tone,
  glyph,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  body: string;
  tone: keyof typeof MARK_COLOR;
  glyph: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const mark = MARK_COLOR[tone];
  const content = (
    <>
      <RN.View style={[styles.topicMark, { borderColor: mark.border, backgroundColor: mark.wash }]}>
        <RN.Text style={[styles.topicGlyph, { color: mark.glyph }]}>{glyph}</RN.Text>
      </RN.View>
      <RN.View style={styles.topicCopy}>
        <RN.Text style={styles.topicTitle}>{title}</RN.Text>
        <RN.Text style={styles.topicBody}>{body}</RN.Text>
      </RN.View>
      {onPress ? <RN.Text style={styles.chevron}>›</RN.Text> : null}
    </>
  );
  if (!onPress) {
    return <RN.View style={styles.topic}>{content}</RN.View>;
  }
  return (
    <RN.Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={styles.topic}
    >
      {content}
    </RN.Pressable>
  );
}

export function Choice({
  selected,
  title,
  hint,
  onPress,
  disabled = false,
}: {
  selected: boolean;
  title: string;
  hint: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <RN.Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceOn]}
    >
      <RN.View style={[styles.radio, selected && styles.radioOn]}>
        {selected ? <RN.View style={styles.radioDot} /> : null}
      </RN.View>
      <RN.View style={styles.choiceCopy}>
        <RN.Text style={styles.choiceTitle}>{title}</RN.Text>
        <RN.Text style={styles.choiceHint}>{hint}</RN.Text>
      </RN.View>
    </RN.Pressable>
  );
}

export function FormatToggle({
  shape,
  onChange,
}: {
  shape: 'csv' | 'json';
  onChange: (shape: 'csv' | 'json') => void;
}) {
  return (
    <RN.View accessibilityRole="radiogroup" style={styles.toggle}>
      <RN.Pressable
        accessibilityRole="button"
        accessibilityLabel="CSV, opens in a spreadsheet"
        accessibilityState={{ selected: shape === 'csv' }}
        onPress={() => onChange('csv')}
        style={[styles.toggleItem, shape === 'csv' && styles.toggleOn]}
      >
        <RN.Text style={[styles.toggleTitle, shape === 'csv' && styles.toggleTitleOn]}>CSV</RN.Text>
        <RN.Text style={[styles.toggleHint, shape === 'csv' && styles.toggleHintOn]}>opens in a spreadsheet</RN.Text>
      </RN.Pressable>
      <RN.Pressable
        accessibilityRole="button"
        accessibilityLabel="JSON, for programs"
        accessibilityState={{ selected: shape === 'json' }}
        onPress={() => onChange('json')}
        style={[styles.toggleItem, shape === 'json' && styles.toggleOn]}
      >
        <RN.Text style={[styles.toggleTitle, shape === 'json' && styles.toggleTitleOn]}>JSON</RN.Text>
        <RN.Text style={[styles.toggleHint, shape === 'json' && styles.toggleHintOn]}>for programs</RN.Text>
      </RN.Pressable>
    </RN.View>
  );
}

export function SealNote({
  children,
  linkLabel,
  onPress,
  linkDisabled = false,
}: {
  children: ReactNode;
  linkLabel?: string;
  onPress?: () => void;
  linkDisabled?: boolean;
}) {
  return (
    <RN.View style={styles.seal}>
      <RN.View style={styles.sealMark}>
        <RN.Text style={styles.sealCheck}>✓</RN.Text>
      </RN.View>
      <RN.View style={styles.sealCopy}>
        <RN.Text style={styles.sealText}>{children}</RN.Text>
        {linkLabel ? (
          <RN.Pressable
            accessibilityRole="link"
            accessibilityLabel={linkLabel}
            accessibilityState={{ disabled: linkDisabled }}
            disabled={linkDisabled}
            onPress={onPress}
            style={styles.sealLink}
          >
            <RN.Text style={[styles.sealLinkText, linkDisabled && styles.sealLinkOff]}>{linkLabel}</RN.Text>
          </RN.Pressable>
        ) : null}
      </RN.View>
    </RN.View>
  );
}

export function BrassButton({
  label,
  onPress,
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <RN.Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.brassButton, disabled && styles.disabled]}
    >
      <RN.Text style={styles.brassLabel}>{label}</RN.Text>
    </RN.Pressable>
  );
}

export function GhostButton({
  label,
  onPress,
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <RN.Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.ghost, disabled && styles.disabled]}
    >
      <RN.Text style={styles.ghostLabel}>{label}</RN.Text>
    </RN.Pressable>
  );
}

const styles = RN.StyleSheet.create({
  glow: {
    position: 'absolute',
    top: -120,
    alignSelf: 'center',
    width: 460,
    height: 220,
    borderRadius: 230,
    backgroundColor: 'rgba(201, 162, 77, 0.16)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchTarget,
  },
  hit: {
    width: touchTarget,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backMark: {
    color: colors.bone,
    fontSize: 22,
    fontFamily: fonts.sans,
  },
  headerTitle: {
    ...typeScale.micro,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  headerEnd: {
    minWidth: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  help: {
    color: colors.body,
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
  },
  cluster: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.brass,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.5)',
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  well: {
    borderRadius: radii.frame,
    borderWidth: 2,
    borderColor: colors.brass,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 8,
  },
  lamps: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  lamp: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.brass,
  },
  kickerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  kicker: {
    ...typeScale.kicker,
    textTransform: 'uppercase',
  },
  aside: {
    ...typeScale.caption,
  },
  topic: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 84,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  topicMark: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topicGlyph: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
  topicCopy: {
    flex: 1,
    gap: 3,
  },
  topicTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 20,
    color: colors.bone,
  },
  topicBody: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.muted,
  },
  chevron: {
    color: colors.muted,
    fontSize: 18,
    fontFamily: fonts.sans,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  choiceOn: {
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
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.brass,
  },
  choiceCopy: {
    flex: 1,
    gap: 2,
  },
  choiceTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.bone,
  },
  choiceHint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  toggle: {
    flexDirection: 'row',
    gap: 3,
    padding: 3,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  toggleItem: {
    flex: 1,
    minHeight: touchTarget,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleOn: {
    backgroundColor: colors.brass,
  },
  toggleTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 16,
    color: colors.body,
  },
  toggleTitleOn: {
    color: colors.forest,
  },
  toggleHint: {
    fontFamily: fonts.sansSemibold,
    fontSize: 10,
    lineHeight: 13,
    color: colors.muted,
  },
  toggleHintOn: {
    color: colors.holdHint,
  },
  seal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.brassLine,
  },
  sealMark: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.brassLine,
    backgroundColor: 'rgba(201, 162, 77, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sealCheck: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
  sealCopy: {
    flex: 1,
    gap: 2,
  },
  sealText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  sealLink: {
    minHeight: 28,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  sealLinkText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.brass,
  },
  sealLinkOff: {
    color: colors.muted,
  },
  brassButton: {
    minHeight: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  brassLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 20,
    color: colors.forest,
    textAlign: 'center',
  },
  ghost: {
    minHeight: touchTarget,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  ghostLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.bone,
    textAlign: 'center',
  },
  disabled: {
    opacity: 0.45,
  },
});
