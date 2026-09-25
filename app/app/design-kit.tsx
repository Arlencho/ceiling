import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  BlockBar,
  BrassFrame,
  CatchMark,
  HoldToApprove,
  Lamp,
  MachineDiagram,
  Pill,
  Plaque,
  ProgressStrip,
  ScoreReel,
  SealRow,
  StatTile,
  TabBar,
  TiltStamp,
  type BackglassTab,
} from '../components/backglass';
import { colors, space, type } from '../components/theme';

const PILLS = [
  { id: 'all', label: 'All' },
  { id: 'paid', label: 'Paid', dot: '#9CC9A8' },
  { id: 'refused', label: 'Refused', dot: '#E4A48E' },
  { id: 'allowed', label: 'Allowed once', dot: '#E3C77E' },
  { id: 'declines', label: "Agent's own declines", dot: 'none' },
] as const;

// Review surface. Reachable only by the deep link veto://design-kit.
export default function DesignKitScreen() {
  const [tab, setTab] = useState<BackglassTab>('home');
  const [pill, setPill] = useState<(typeof PILLS)[number]['id']>('all');
  const [approved, setApproved] = useState(0);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>Design kit</Text>
      <Text style={styles.display}>Backglass</Text>
      <Text style={styles.body}>
        Opened with veto://design-kit. Nothing in the app links here.
      </Text>

      <Text style={styles.section}>Catch mark</Text>
      <View style={styles.row}>
        <CatchMark size={48} />
        <CatchMark size={48} variant="bone" />
        <View style={styles.boneChip}>
          <CatchMark size={48} variant="forest" />
        </View>
      </View>

      <Text style={styles.section}>Brass frame</Text>
      <BrassFrame chase>
        <Text style={styles.body}>Chase lamps along the cabinet rail.</Text>
      </BrassFrame>
      <BrassFrame>
        <Text style={styles.body}>The same frame with the lamps off.</Text>
      </BrassFrame>

      <Text style={styles.section}>Lamps</Text>
      <View style={styles.row}>
        <Lamp state="off" size={18} />
        <Lamp state="on" size={18} />
        <Lamp state="pulse" size={18} />
      </View>

      <Text style={styles.section}>Score reels</Text>
      <View style={styles.row}>
        <ScoreReel value={12} tone="amber" accessibilityLabel="12 refusals" />
        <ScoreReel value={300} tone="brass" accessibilityLabel="300 set aside" />
        <ScoreReel value={6} tone="paid" accessibilityLabel="6 payments paid" />
      </View>

      <Text style={styles.section}>Block bar</Text>
      <BrassFrame>
        <Text style={styles.caption}>258 remaining of 300</Text>
        <BlockBar remaining={258} cap={300} />
        <Text style={styles.caption}>Empty, then full</Text>
        <BlockBar remaining={0} cap={300} />
        <BlockBar remaining={300} cap={300} />
      </BrassFrame>

      <Text style={styles.section}>First run</Text>
      <ProgressStrip current="learn" />
      <ProgressStrip current="approve" done={['learn', 'connect', 'agent']} />
      <ProgressStrip current="protect" done={['learn', 'connect', 'agent', 'approve', 'live']} />

      <Text style={styles.section}>Machine</Text>
      <BrassFrame>
        <MachineDiagram litStations={['you', 'agent']} />
        <MachineDiagram litStations={['you', 'rule']} />
        <MachineDiagram
          litStations={['you', 'agent', 'rule', 'paidOrRefused', 'blockchain', 'phone']}
        />
      </BrassFrame>

      <Text style={styles.section}>Tilt</Text>
      <TiltStamp />
      <TiltStamp reason="Refused: rule not active" />

      <Text style={styles.section}>Press and hold to approve</Text>
      <HoldToApprove onConfirm={() => setApproved((count) => count + 1)} />
      <Text style={styles.caption}>Approved {approved} times</Text>

      <Text style={styles.section}>Seal</Text>
      <SealRow onPress={() => undefined} />
      <SealRow
        text="This refusal is saved on the blockchain with its reason. Anyone can check it."
        onPress={() => undefined}
      />

      <Text style={styles.section}>Plaques</Text>
      <Plaque
        date="Day 1, Sun 20 Sep"
        title="First payment inside the rule"
        detail="Paid 8 to 6i99...PdCG. Limit per payment: 10."
        onShare={() => undefined}
      />
      <Plaque
        earned={false}
        date="Not yet: day 90, Fri 18 Dec"
        title="Rule finished, rest returned"
        detail="Engraved if the rule runs to its end."
      />

      <Text style={styles.section}>Stats</Text>
      <View style={styles.stats}>
        <StatTile value="61" label="payments paid, all within the rule" valueColor={colors.paid} />
        <StatTile value="11" label="payments refused, 0 moved" valueColor={colors.refused} />
      </View>
      <View style={styles.stats}>
        <StatTile value="0" label="allowed by the owner after a refusal" />
        <StatTile value="268" suffix="of 300" label="spent. 32 returned to the owner." />
      </View>

      <Text style={styles.section}>Pills</Text>
      <View style={styles.pills}>
        {PILLS.map((item) => (
          <Pill
            key={item.id}
            label={item.label}
            dot={'dot' in item ? item.dot : undefined}
            selected={pill === item.id}
            onPress={() => setPill(item.id)}
          />
        ))}
      </View>

      <Text style={styles.section}>Tab bar</Text>
      <TabBar active={tab} onChange={setTab} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingTop: 48,
    paddingHorizontal: space.screen,
    paddingBottom: 48,
    gap: space.xxl,
  },
  kicker: {
    ...type.kicker,
    textTransform: 'uppercase',
  },
  display: {
    ...type.display,
  },
  section: {
    ...type.kicker,
    textTransform: 'uppercase',
    marginTop: space.md,
  },
  body: {
    ...type.body,
  },
  caption: {
    ...type.caption,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxxl,
  },
  boneChip: {
    backgroundColor: colors.bone,
    borderRadius: 12,
    padding: space.md,
  },
  stats: {
    flexDirection: 'row',
    gap: space.md,
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
});
