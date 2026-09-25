import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Lamp, type LampState } from '../backglass/Lamp';
import { motionAllowed, useReducedMotion } from '../backglass/motion';

export function DimLamps({ count = 10 }: { count?: number }) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const [state, setState] = useState<LampState>('off');

  useEffect(() => {
    if (!motionOn) {
      return;
    }
    const lit = setTimeout(() => setState('on'), 0);
    const dim = setTimeout(() => setState('off'), 700);
    return () => {
      clearTimeout(lit);
      clearTimeout(dim);
    };
  }, [motionOn]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.row}
    >
      {Array.from({ length: count }, (_, index) => (
        <Lamp key={index} state={state} testID={`dim-lamp-${index}`} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
});
