import { useMemo } from 'react';
import { Image, StyleSheet } from 'react-native';

import { qrPngDataUri } from '../lib/qrPng';

export function QrCode({ value }: { value: string }) {
  const image = useMemo(() => qrPngDataUri(value), [value]);
  return (
    <Image
      accessibilityRole="image"
      accessibilityLabel="QR code of the agent config"
      source={{ uri: image.uri }}
      resizeMode="contain"
      style={[styles.image, { width: image.size, height: image.size }]}
    />
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: '#ffffff',
    alignSelf: 'center',
  },
});
