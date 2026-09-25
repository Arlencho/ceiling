import { useWallet } from '../lib/useWallet';
import { LearnStory } from './firstrun/LearnStory';

export function OnboardingCards(props: {
  onSkip: () => Promise<void> | void;
  onConnect: () => Promise<void> | void;
  onConnectOther?: () => Promise<void> | void;
  connectBusy?: boolean;
  showConnect: boolean;
  showOtherWallet?: boolean;
}) {
  const wallet = useWallet();
  return <LearnStory {...props} cluster={wallet.cluster} />;
}
