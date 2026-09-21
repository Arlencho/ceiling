import { REASON_NOT_ACTIVE, REASON_OVER_PER_TX_MAX, reasonText } from './constants';
import { formatBaseUnits } from './format';

export { reasonText };

export type ReasonView = {
  reason: number;
  text: string;
  overrideLine: string | null;
};

export function renderReason(
  reason: number,
  suggestedOverride: bigint,
  decimals: number,
): ReasonView {
  const text = reasonText(reason);
  if (reason !== REASON_OVER_PER_TX_MAX) {
    return { reason, text, overrideLine: null };
  }
  if (suggestedOverride > 0n) {
    return {
      reason,
      text,
      overrideLine: `An override of ${formatBaseUnits(suggestedOverride, decimals)} would have cleared it.`,
    };
  }
  return {
    reason,
    text,
    overrideLine: 'No override would have cleared this.',
  };
}

export function refusalWhyLine(args: {
  reason: number;
  amount: bigint;
  suggestedOverride: bigint;
  decimals: number;
  perTxMax?: bigint;
}): string {
  const view = renderReason(args.reason, args.suggestedOverride, args.decimals);
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    const amount = formatBaseUnits(args.amount, args.decimals);
    const limit = formatBaseUnits(args.perTxMax, args.decimals);
    const extra = view.overrideLine ? ` ${view.overrideLine}` : '';
    return `Asked for ${amount}, over the ${limit} per-payment maximum.${extra}`;
  }
  const extra = view.overrideLine ? ` ${view.overrideLine}` : '';
  return `${view.text}.${extra}`.trim();
}

export function notActiveHint(): string {
  return `The agent's next charge is refused with reason ${REASON_NOT_ACTIVE} (${reasonText(REASON_NOT_ACTIVE)}) and that refusal is written to the ledger.`;
}
