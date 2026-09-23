import type { WalletStore } from './wallet';

/** Same shape as `veto.notify.asked`: a `'1'` flag in the secure store. */
export const ONBOARDING_SEEN_KEY = 'veto.onboarding.seen';

export type OnboardingCard = {
  title: string;
  body: string;
};

export const ONBOARDING_CARDS: readonly OnboardingCard[] = [
  {
    title: 'It can only ask',
    body: 'Your agent holds no funds and cannot move your money on its own. It can only ask the program to pay inside the rule.',
  },
  {
    title: 'One rule',
    body: 'You write one rule: who may be paid, the largest single payment, a total cap, and an expiry. The program enforces those limits.',
  },
  {
    title: 'A recorded no',
    body: 'When it asks for more than the largest single payment, the program does not pay. The chain records why: a transaction that moved nothing, with the reason.',
  },
  {
    title: 'You decide',
    body: 'Your phone can tell you, and you decide: allow that one payment above the per-payment ceiling when it stays inside the total cap, or revoke the rule. Anyone can check the record against the chain.',
  },
];

export const SEED_VAULT_LINE =
  'The owner key stays in Seed Vault. This app never sees it.';

export const OPEN_FIRST_RULE_LABEL = 'Open your first rule';

export const OPEN_FIRST_RULE_NEXT =
  'You set the payee, the largest single payment, a total cap, and an expiry, then sign with the key in Seed Vault.';

export async function loadOnboardingSeen(store: WalletStore): Promise<boolean> {
  const raw = await store.getItem(ONBOARDING_SEEN_KEY);
  return raw === '1';
}

export async function markOnboardingSeen(store: WalletStore): Promise<void> {
  await store.setItem(ONBOARDING_SEEN_KEY, '1');
}

/** First run, before Connect. A connected owner is already past it. Help opens the cards on its own route. */
export function showsIntroduction(args: { connected: boolean; seen: boolean }): boolean {
  return !args.connected && !args.seen;
}
