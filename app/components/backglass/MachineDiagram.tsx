import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { Circle, G, Path, Rect, Svg, Text as SvgText } from 'react-native-svg';

import { colors, fonts } from '../theme';
import { motionAllowed, useReducedMotion } from './motion';

export const MACHINE_STATIONS = [
  { id: 'you', label: 'You' },
  { id: 'agent', label: 'Your agent' },
  { id: 'rule', label: 'The rule' },
  { id: 'paidOrRefused', label: 'Paid or refused' },
  { id: 'blockchain', label: 'Saved on the blockchain' },
  { id: 'phone', label: 'Your phone' },
] as const;

export type MachineStationId = (typeof MACHINE_STATIONS)[number]['id'];

const CENTERS: Record<MachineStationId, { x: number; y: number }> = {
  you: { x: 48, y: 52 },
  agent: { x: 155, y: 52 },
  rule: { x: 262, y: 58 },
  paidOrRefused: { x: 262, y: 142 },
  blockchain: { x: 155, y: 142 },
  phone: { x: 48, y: 142 },
};

const RAILS: { id: string; d: string; from: MachineStationId; to: MachineStationId; dashed?: boolean }[] = [
  { id: 'you-agent', d: 'M70 52H133', from: 'you', to: 'agent' },
  { id: 'agent-rule', d: 'M177 52H244', from: 'agent', to: 'rule' },
  { id: 'rule-paid', d: 'M262 80V120', from: 'rule', to: 'paidOrRefused' },
  { id: 'paid-chain', d: 'M234 142H177', from: 'paidOrRefused', to: 'blockchain' },
  { id: 'chain-phone', d: 'M135 142H70', from: 'blockchain', to: 'phone' },
  { id: 'phone-you', d: 'M48 122V76', from: 'phone', to: 'you', dashed: true },
];

const ARROWS = [
  'M126 48l4 4-4 4',
  'M237 48l4 4-4 4',
  'M258 113l4 4 4-4',
  'M184 138l-4 4 4 4',
  'M77 138l-4 4 4 4',
  'M44 83l4-4 4 4',
];

type MachineDiagramProps = {
  litStations?: readonly MachineStationId[];
  width?: number;
  accessibilityLabel?: string;
};

function stationLabel(id: MachineStationId, lit: boolean, x: number, y: number, lines: string[]) {
  return lines.map((line, index) => (
    <SvgText
      key={`${id}-${line}`}
      x={x}
      y={y + index * 12}
      textAnchor="middle"
      fontFamily={fonts.sansBold}
      fontSize={9.5}
      letterSpacing={1.2}
      fill={lit ? colors.brass : colors.muted}
    >
      {line}
    </SvgText>
  ));
}

export function MachineDiagram({
  litStations = [],
  width = 310,
  accessibilityLabel,
}: MachineDiagramProps) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const lit = useMemo(() => new Set(litStations), [litStations]);
  const [reveal] = useState(() => new Animated.Value(0));
  const [revealAmount, setRevealAmount] = useState(0);
  const shown = motionOn ? revealAmount : 1;
  const height = Math.round((width * 196) / 310);
  const litNames = MACHINE_STATIONS.filter((station) => lit.has(station.id)).map((station) => station.label);
  const label =
    accessibilityLabel ??
    `The Veto machine. Lit stations: ${litNames.length > 0 ? litNames.join(', ') : 'none'}.`;
  const firstLit = MACHINE_STATIONS.find((station) => lit.has(station.id));
  const ball = firstLit ? CENTERS[firstLit.id] : null;
  const litKey = litStations.join(',');

  useEffect(() => {
    if (!motionOn) {
      return;
    }
    reveal.setValue(0);
    const listener = reveal.addListener(({ value }) => {
      setRevealAmount(value);
    });
    const anim = Animated.timing(reveal, {
      toValue: 1,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => {
      reveal.removeListener(listener);
      anim.stop();
    };
  }, [litKey, motionOn, reveal]);

  function stationOpacity(id: MachineStationId): number {
    if (!lit.has(id)) {
      return 0.38;
    }
    return 0.38 + shown * 0.62;
  }

  return (
    <Svg
      width={width}
      height={height}
      viewBox="0 0 310 196"
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      {RAILS.map((rail) => {
        const on = lit.has(rail.from) || lit.has(rail.to);
        return (
          <Path
            key={rail.id}
            d={rail.d}
            fill="none"
            stroke={on ? colors.brass : 'rgba(201, 162, 77, 0.28)'}
            strokeWidth={1.5}
            strokeDasharray={rail.dashed ? '3 4' : undefined}
          />
        );
      })}
      {ARROWS.map((d) => (
        <Path
          key={d}
          d={d}
          fill="none"
          stroke="rgba(201, 162, 77, 0.28)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      <G testID="station-you" opacity={stationOpacity('you')}>
        <Circle cx={48} cy={52} r={20} fill={colors.forest} stroke={colors.brass} strokeWidth={1.5} />
        <Circle cx={48} cy={46} r={4.5} fill="none" stroke={colors.bone} strokeWidth={1.5} />
        <Path
          d="M39.5 62c1.5-5.5 4.5-8 8.5-8s7 2.5 8.5 8"
          fill="none"
          stroke={colors.bone}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
        {stationLabel('you', lit.has('you'), 48, 90, ['YOU'])}
      </G>

      <G testID="station-agent" opacity={stationOpacity('agent')}>
        <Circle cx={155} cy={52} r={20} fill={colors.forest} stroke={colors.brass} strokeWidth={1.5} />
        <SvgText
          x={155}
          y={58}
          textAnchor="middle"
          fontFamily={fonts.serif}
          fontSize={18}
          fill={colors.bone}
        >
          ?
        </SvgText>
        {stationLabel('agent', lit.has('agent'), 155, 90, ['YOUR AGENT'])}
      </G>

      <G testID="station-rule" opacity={stationOpacity('rule')}>
        <Path
          d="M246 76V44Q246 34 256 34H268Q278 34 278 44V76"
          fill="none"
          stroke={colors.brass}
          strokeWidth={3}
          strokeLinecap="round"
        />
        <Rect
          x={232}
          y={12}
          width={60}
          height={17}
          rx={8.5}
          fill={colors.forest}
          stroke="rgba(201, 162, 77, 0.7)"
          strokeWidth={1}
        />
        <SvgText x={262} y={24} textAnchor="middle" fontFamily={fonts.sansBold} fontSize={9} fill={colors.brass}>
          MAX 10
        </SvgText>
        <Circle cx={262} cy={58} r={4.5} fill="rgba(242, 185, 75, 0.18)" stroke="rgba(242, 185, 75, 0.6)" strokeWidth={1} />
        {stationLabel('rule', lit.has('rule'), 262, 90, ['THE RULE'])}
      </G>

      <G
        testID="station-paidOrRefused"
        opacity={stationOpacity('paidOrRefused')}
      >
        <Rect x={236} y={124} width={52} height={36} rx={8} fill={colors.forest} stroke={colors.brass} strokeWidth={1.5} />
        <Circle cx={250} cy={142} r={5} fill="rgba(156, 201, 168, 0.18)" stroke="rgba(156, 201, 168, 0.6)" strokeWidth={1} />
        <Circle cx={274} cy={142} r={5} fill="rgba(242, 185, 75, 0.18)" stroke="rgba(242, 185, 75, 0.6)" strokeWidth={1} />
        {stationLabel('paidOrRefused', lit.has('paidOrRefused'), 262, 177, ['PAID OR', 'REFUSED'])}
      </G>

      <G
        testID="station-blockchain"
        opacity={stationOpacity('blockchain')}
      >
        <Rect x={137} y={126} width={36} height={32} rx={6} fill={colors.forest} stroke={colors.brass} strokeWidth={1.5} />
        <Path d="M143 135h24M143 142h16M143 149h20" stroke={colors.bone} strokeWidth={1.4} strokeLinecap="round" />
        <Circle cx={172} cy={127} r={6.5} fill={colors.surface} stroke={colors.brass} strokeWidth={1.2} />
        <Path
          d="M169 127l2 2 4-4"
          fill="none"
          stroke={colors.brass}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {stationLabel('blockchain', lit.has('blockchain'), 155, 177, ['SAVED ON', 'THE BLOCKCHAIN'])}
      </G>

      <G testID="station-phone" opacity={stationOpacity('phone')}>
        <Rect x={37} y={123} width={22} height={38} rx={5} fill={colors.forest} stroke={colors.brass} strokeWidth={1.5} />
        <Path d="M44 129h8" stroke={colors.bone} strokeWidth={1.4} strokeLinecap="round" />
        <Circle cx={58} cy={125} r={4} fill={colors.refused} />
        {stationLabel('phone', lit.has('phone'), 48, 177, ['YOUR PHONE'])}
      </G>

      {motionOn && ball ? (
        <G testID="machine-ball" opacity={shown}>
          <Circle cx={ball.x} cy={ball.y} r={5} fill={colors.amber} stroke={colors.deepBrass} strokeWidth={1} />
        </G>
      ) : null}
    </Svg>
  );
}
