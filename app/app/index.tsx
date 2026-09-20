import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        <Text style={styles.name}>Veto</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connect"
          onPress={() => {}}
          style={({ pressed }) => [styles.connect, pressed && styles.connectPressed]}
        >
          <Text style={styles.connectLabel}>Connect</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0B0B0B',
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    paddingHorizontal: 24,
  },
  name: {
    color: '#F5F5F5',
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  connect: {
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    minWidth: 200,
    paddingHorizontal: 28,
    paddingVertical: 14,
    alignItems: 'center',
  },
  connectPressed: {
    opacity: 0.7,
  },
  connectLabel: {
    color: '#0B0B0B',
    fontSize: 17,
    fontWeight: '600',
  },
});
