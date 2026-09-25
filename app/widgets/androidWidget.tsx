'use no memo';

import type { ReactNode } from 'react';
import { FlexWidget, SvgWidget, TextWidget, type ColorProp } from 'react-native-android-widget';

import { BLOCK_COUNT, blockFills } from '../components/backglass/BlockBar';
import { colors, fonts, radii } from '../components/theme';
import {
  CATCH_MARK_PATH,
  WIDGET_LOADING_COPY,
  describeWidget,
  type WidgetDraw,
} from '../lib/widgetData';

// RemoteViews cannot host the cabinet BlockBar, so the segments use blockFills.
function paint(color: string): ColorProp {
  return color as ColorProp;
}

function catchMarkSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${CATCH_MARK_PATH}" fill="none" stroke="${colors.brass}" stroke-width="9" stroke-linecap="butt" stroke-linejoin="miter"/><circle cx="50" cy="37.4" r="12" fill="${colors.amber}" stroke="${colors.deepBrass}" stroke-width="2"/></svg>`;
}

type OpenAction =
  | { clickAction: 'OPEN_APP' }
  | { clickAction: 'OPEN_URI'; clickActionData: { uri: string } };

function shell(label: string, open: OpenAction, children: ReactNode, radius: number) {
  return (
    <FlexWidget
      accessibilityLabel={label}
      clickAction={open.clickAction}
      clickActionData={'clickActionData' in open ? open.clickActionData : undefined}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        flex: 1,
        padding: 2,
        borderRadius: radius,
        backgroundGradient: {
          from: colors.amber,
          to: colors.deepBrass,
          orientation: 'TL_BR',
        },
      }}
    >
      <FlexWidget
        clickAction={open.clickAction}
        clickActionData={'clickActionData' in open ? open.clickActionData : undefined}
        style={{
          flex: 1,
          width: 'match_parent',
          height: 'match_parent',
          padding: radius > 20 ? 12 : 10,
          borderRadius: radius - 2,
          flexDirection: 'column',
          flexGap: 8,
          backgroundGradient: {
            from: colors.forestLift,
            to: colors.surface,
            orientation: 'TOP_BOTTOM',
          },
        }}
      >
        {children}
      </FlexWidget>
    </FlexWidget>
  );
}

function Mark({ size }: { size: number }) {
  return <SvgWidget svg={catchMarkSvg()} style={{ width: size, height: size }} />;
}

function Segment({ amount }: { amount: number }) {
  const steps = 8;
  const on = Math.max(0, Math.min(steps, Math.round(amount * steps)));
  const off = steps - on;
  return (
    <FlexWidget
      style={{
        flex: 1,
        height: 10,
        flexDirection: 'row',
        borderRadius: radii.bar,
        backgroundColor: paint(colors.blockOff),
      }}
    >
      {on > 0 ? (
        <FlexWidget
          style={{ flex: on, height: 10, borderRadius: radii.bar, backgroundColor: colors.brass }}
        />
      ) : null}
      {off > 0 ? <FlexWidget style={{ flex: off, height: 10 }} /> : null}
    </FlexWidget>
  );
}

function BlockStrip({ remaining, cap }: { remaining: number; cap: number }) {
  const fills = blockFills(remaining, cap, BLOCK_COUNT);
  return (
    <FlexWidget style={{ width: 'match_parent', height: 10, flexDirection: 'row', flexGap: 2 }}>
      {fills.map((amount, index) => (
        <Segment key={index} amount={amount} />
      ))}
    </FlexWidget>
  );
}

export function widgetElement(draw: WidgetDraw) {
  if (draw.kind === 'message') {
    const label = `Veto widget. ${draw.body}`;
    return shell(
      label,
      { clickAction: 'OPEN_APP' },
      [
        <FlexWidget
          key="head"
          style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', flexGap: 8 }}
        >
          <Mark size={16} />
          <TextWidget
            text="VETO"
            style={{ fontSize: 11, fontFamily: fonts.sansBold, color: colors.muted, letterSpacing: 1.2 }}
          />
        </FlexWidget>,
        <TextWidget
          key="body"
          text={draw.body}
          maxLines={4}
          style={{ fontSize: 15, fontFamily: fonts.sans, color: colors.body }}
        />,
      ],
      radii.frame,
    );
  }

  const { face, size } = draw;
  const large = size === 'large';
  const open: OpenAction = { clickAction: 'OPEN_URI', clickActionData: { uri: face.uri } };
  return shell(describeWidget(face, size), open, [
      <FlexWidget key="head" style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', flexGap: 8 }}>
        <Mark size={large ? 16 : 12} />
        <FlexWidget style={{ flex: 1 }}>
          <TextWidget
            text={face.heading.toUpperCase()}
            maxLines={3}
            style={{ fontSize: 11, fontFamily: fonts.sansBold, color: colors.muted, letterSpacing: 1.2 }}
          />
        </FlexWidget>
        {large ? (
          <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', flexGap: 6 }}>
            {face.live ? (
              <FlexWidget
                style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.paid }}
              />
            ) : null}
            <TextWidget
              text={face.statusLine.toUpperCase()}
              style={{
                fontSize: 10,
                fontFamily: fonts.sansBold,
                letterSpacing: 0.8,
                color: face.live ? colors.paid : colors.muted,
              }}
            />
          </FlexWidget>
        ) : null}
      </FlexWidget>,
      <FlexWidget key="figures" style={{ flexDirection: 'row', alignItems: 'flex-end', width: 'match_parent', flexGap: 8 }}>
        <TextWidget
          text={face.remainingText}
          maxLines={1}
          style={{
            fontSize: large ? 48 : 32,
            fontFamily: fonts.serifLight,
            color: colors.bone,
            adjustsFontSizeToFit: true,
          }}
        />
        <TextWidget
          text={`of ${face.capText}`}
          style={{
            fontSize: large ? 18 : 14,
            fontFamily: fonts.serifLight,
            color: colors.muted,
          }}
        />
        {large ? <FlexWidget style={{ flex: 1 }} /> : null}
        {large ? (
          <FlexWidget style={{ alignItems: 'flex-end' }}>
            <TextWidget
              text={face.daysLeft}
              style={{ fontSize: 12, fontFamily: fonts.sans, color: colors.body, textAlign: 'right' }}
            />
            <TextWidget
              text={face.ends}
              style={{ fontSize: 12, fontFamily: fonts.sans, color: colors.muted, textAlign: 'right' }}
            />
          </FlexWidget>
        ) : null}
      </FlexWidget>,
      large ? <BlockStrip key="bar" remaining={face.barRemaining} cap={face.barCap} /> : null,
      <FlexWidget
        key="decision"
        style={{
          width: 'match_parent',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          ...(large
            ? { borderTopWidth: 1, borderTopColor: paint(colors.boneLine), paddingTop: 6 }
            : {}),
        }}
      >
        <FlexWidget style={{ flex: 1 }}>
          <TextWidget
            text={large ? face.decisionLine : face.decisionShort}
            maxLines={2}
            style={{ fontSize: 12, fontFamily: fonts.sans, color: colors.body }}
          />
        </FlexWidget>
        {large ? (
          <TextWidget
            text={face.tally}
            style={{ fontSize: 12, fontFamily: fonts.sans, color: colors.muted }}
          />
        ) : null}
      </FlexWidget>,
      <TextWidget
        key="updated"
        text={face.updatedLabel}
        style={{ fontSize: 11, fontFamily: fonts.sans, color: colors.muted }}
      />,
    ],
    large ? radii.frame : radii.row,
  );
}

export function loadingWidgetElement() {
  return widgetElement({ kind: 'message', body: WIDGET_LOADING_COPY });
}
