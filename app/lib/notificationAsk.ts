export const DECISION_NOTIFICATION_EXPLANATION =
  'Decision notifications need Android notification permission so this phone can tell you when a rule pays or refuses. If you deny permission, nothing is announced. Background checks run about every 15 minutes and can be delayed by battery optimisation.';

export async function explainOnceThenAsk(args: {
  alreadyAsked: boolean;
  showExplanation: (copy: string) => Promise<void>;
  ask: () => Promise<void>;
}): Promise<void> {
  if (!args.alreadyAsked) {
    await args.showExplanation(DECISION_NOTIFICATION_EXPLANATION);
  }
  await args.ask();
}
