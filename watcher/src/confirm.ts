import { Connection, Transaction, type Finality, type Keypair, type TransactionSignature } from "@solana/web3.js";
import { logError } from "./log.js";
import { RateLimitedError, isRateLimitError, sleep } from "./rpc.js";

export type RejectionDisposition = "discarded" | "fatal";

let answeredConfirms = 0;

export function noteConfirmAnswered(): void {
  answeredConfirms += 1;
}

export function consumeConfirmAnswer(): boolean {
  if (answeredConfirms <= 0) return false;
  answeredConfirms -= 1;
  return true;
}

export function handleUnhandledRejection(
  reason: unknown,
  opts: { confirmAlreadyAnswered: boolean; log?: (line: string) => void },
): RejectionDisposition {
  const log = opts.log ?? logError;
  const message = reason instanceof Error ? reason.message : String(reason);
  if (opts.confirmAlreadyAnswered && isRateLimitError(reason)) {
    log(`unhandled rejection after confirm no longer needed this answer: ${message}`);
    return "discarded";
  }
  log(`unhandled rejection: ${message}`);
  return "fatal";
}

export function installUnhandledRejectionHandler(
  log: (line: string) => void = logError,
): void {
  process.on("unhandledRejection", (reason) => {
    const disposition = handleUnhandledRejection(reason, {
      confirmAlreadyAnswered: consumeConfirmAnswer(),
      log,
    });
    if (disposition === "fatal") process.exitCode = 1;
  });
}

function meetsCommitment(status: string | null | undefined, commitment: Finality): boolean {
  if (status === "finalized") return true;
  if (commitment === "finalized") return false;
  return status === "confirmed";
}

function leftoverLine(signature: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `confirm: leftover status poll after ${signature} was already confirmed: ${message}`;
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  opts: {
    commitment?: Finality;
    graceMs?: number;
    log?: (line: string) => void;
  } = {},
): Promise<void> {
  const commitment = opts.commitment ?? "confirmed";
  const graceMs = opts.graceMs ?? 2_000;
  const log = opts.log ?? logError;

  let answered = false;
  let leftover: unknown = null;
  let subId: number | undefined;

  const markAnswered = (): void => {
    if (answered) return;
    answered = true;
    noteConfirmAnswered();
  };

  const logLeftover = (err: unknown): void => {
    leftover = leftover ?? err;
    log(leftoverLine(signature, err));
  };

  const ws = new Promise<void>((resolve, reject) => {
    subId = connection.onSignature(
      signature,
      (result) => {
        markAnswered();
        if (result.err) {
          reject(new Error(`transaction ${signature} failed: ${JSON.stringify(result.err)}`));
          return;
        }
        resolve();
      },
      commitment,
    );
  });

  const poll = (async () => {
    try {
      const { value } = await connection.getSignatureStatus(signature);
      if (answered) return;
      if (value?.err) {
        throw new Error(`transaction ${signature} failed: ${JSON.stringify(value.err)}`);
      }
      if (meetsCommitment(value?.confirmationStatus, commitment)) {
        markAnswered();
      }
    } catch (err) {
      leftover = err;
      if (answered) {
        logLeftover(err);
        return;
      }
      throw err;
    }
  })();

  void poll.catch((err) => {
    leftover = leftover ?? err;
    if (answered) logLeftover(err);
  });

  try {
    const winner = await Promise.race([
      ws.then(() => "ws" as const),
      poll.then(() => "poll" as const).catch((err) => {
        leftover = leftover ?? err;
        return "throttled" as const;
      }),
    ]);

    if (winner === "ws" || (winner === "poll" && answered)) {
      if (leftover !== null) logLeftover(leftover);
      return;
    }

    try {
      await Promise.race([
        ws,
        sleep(graceMs).then(() => {
          throw leftover instanceof Error
            ? leftover
            : new RateLimitedError(String(leftover ?? "confirm status poll failed"));
        }),
      ]);
      if (leftover !== null) logLeftover(leftover);
    } catch (err) {
      if (answered) {
        logLeftover(err);
        return;
      }
      throw err;
    }
  } finally {
    if (subId !== undefined) {
      await connection.removeSignatureListener(subId);
    }
  }
}

export async function sendAndConfirm(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts?: { commitment?: Finality; log?: (line: string) => void },
): Promise<TransactionSignature> {
  const commitment = opts?.commitment ?? "confirmed";
  const signature = await connection.sendTransaction(tx, signers, {
    skipPreflight: false,
    preflightCommitment: commitment,
  });
  await confirmSignature(connection, signature, { commitment, log: opts?.log });
  return signature;
}
