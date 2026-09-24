import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '../components/Button';
import { RuleScreen } from '../components/RuleScreen';
import { TopBar } from '../components/TopBar';
import { colors, fonts } from '../components/theme';
import { readScannedText, ruleRequestHref } from '../lib/ruleRequest';
import { stageAddressScan, type AddressScanTarget } from '../lib/scanHandoff';

export default function ScanScreen() {
  const params = useLocalSearchParams<{ target?: string }>();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);
  const target: AddressScanTarget | 'request' =
    params.target === 'agent' || params.target === 'payee' ? params.target : 'request';

  if (!permission) {
    return (
      <RuleScreen>
        <TopBar back="Back" />
        <Text style={styles.body}>Checking the camera.</Text>
      </RuleScreen>
    );
  }

  if (!permission.granted) {
    return (
      <RuleScreen>
        <TopBar back="Back" />
        <Text style={styles.body}>
          {permission.canAskAgain
            ? 'Veto needs the camera to scan a rule request.'
            : 'The camera is off for Veto. Turn it on in system settings, then come back.'}
        </Text>
        {permission.canAskAgain ? (
          <Button
            label="Allow the camera"
            accessibilityLabel="Allow the camera"
            onPress={() => {
              void requestPermission();
            }}
          />
        ) : null}
      </RuleScreen>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TopBar back="Back" />
        <Text style={styles.body}>Point the camera at a rule request code, or at an address code.</Text>
        {error ? <Text style={styles.body}>{error}</Text> : null}
      </View>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(result) => {
          if (handled.current) {
            return;
          }
          handled.current = true;
          const read = readScannedText(result.data);
          if (read.kind === 'request') {
            const href = ruleRequestHref(read.url);
            if (href) {
              router.replace(href as Href);
              return;
            }
          }
          if (target !== 'request' && read.kind === 'address') {
            stageAddressScan(target, read.address);
            router.back();
            return;
          }
          setError(
            read.kind === 'invalid'
              ? read.reason
              : target === 'request'
                ? 'That code is not a rule request.'
                : 'That code is not an address.',
          );
          handled.current = false;
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 8,
  },
  body: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },
  camera: {
    flex: 1,
    marginTop: 12,
  },
});
