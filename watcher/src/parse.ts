import { reasonText } from "./reasons.js";

export type ChargeOutcome = {
  decision: "paid" | "refused";
  reason: string;
  reasonCode: number;
  suggestedOverride: bigint | null;
};

const PAID_RE = /VETO PAID amount=(\d+)/;
const REFUSED_RE =
  /VETO REFUSED reason=(\d+) \(([^)]*)\) amount=(\d+).*override_to_clear=(\d+)/;

export function parseChargeLogs(logs: readonly string[]): ChargeOutcome {
  for (const line of logs) {
    const paid = PAID_RE.exec(line);
    if (paid) {
      return {
        decision: "paid",
        reason: "ok",
        reasonCode: 0,
        suggestedOverride: null,
      };
    }
    const refused = REFUSED_RE.exec(line);
    if (refused) {
      const code = Number.parseInt(refused[1] ?? "0", 10);
      const text = refused[2] && refused[2].length > 0 ? refused[2] : reasonText(code);
      const overrideRaw = refused[4] ?? "0";
      return {
        decision: "refused",
        reason: text,
        reasonCode: code,
        suggestedOverride: BigInt(overrideRaw),
      };
    }
  }
  throw new Error("parse.parseChargeLogs: confirmed transaction had neither PAID nor REFUSED");
}
