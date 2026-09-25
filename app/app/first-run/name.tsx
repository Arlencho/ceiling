import { useRouter } from 'expo-router';
import { useState } from 'react';

import { NameAgentScreen } from '../../components/firstrun/NameAgentScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { canonicalAddress, parseRuleRequest } from '../../lib/ruleRequest';
import { useWallet } from '../../lib/useWallet';

export default function NameRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const [paste, setPaste] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(wallet.agentPublicKey);
  const [error, setError] = useState<string | null>(null);

  return (
    <Screen>
      <NameAgentScreen
        cluster={wallet.cluster}
        address={address}
        name={name}
        onName={setName}
        facts={null}
        error={error}
        showPaste
        paste={paste}
        onPaste={setPaste}
        onBack={() => router.back()}
        onReject={() => router.back()}
        onReview={() => {
          const parsed = parseRuleRequest(paste);
          if (parsed.ok) {
            router.push(`${FIRST_RUN_ROUTES.approve}?url=${encodeURIComponent(paste)}`);
            return;
          }
          const next = canonicalAddress(paste.trim()) ?? address;
          if (!next) {
            setError('That is not an agent address or a rule request.');
            return;
          }
          setAddress(next);
          router.push(FIRST_RUN_ROUTES.approve);
        }}
      />
    </Screen>
  );
}
