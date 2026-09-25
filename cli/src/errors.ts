export class CliError extends Error {
  readonly code: string;

  constructor(message: string, code = "error") {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

/** Printed when getProgramAccounts filters are refused. --rule is the fallback. */
export const FILTERS_REFUSED =
  "The RPC refuses getProgramAccounts filters. Pass --rule <address>.";

export function rpcRefusesFilters(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /getProgramAccounts|secondary index|method not found|410 gone/i.test(message);
}

export function isForeignAgent(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("does not equal the agent key");
}
