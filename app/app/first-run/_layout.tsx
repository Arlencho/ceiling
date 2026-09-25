import { Stack } from 'expo-router';

import { colors } from '../../components/theme';

export default function FirstRunLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
