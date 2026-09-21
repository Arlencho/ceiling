import { Connection, Transaction, type Finality, type Keypair, type TransactionSignature } from "@solana/web3.js";
import { logError } from "./log.js";
import { sleep } from "./rpc.js";

export type RejectionDisposition = "discarded" | "fatal";

const POLL_MS = 1_000;

/** Always false. Leftover polls are handled inside confirmSignature. Kept so
 * fixtures that drain a leftover counter still compile and stay honest. */
export function consumeConfirmAnswer(): boolean {
  return false;
}

export function handleUnhandledRejection(
  reason: unknown,
  opts: { confirmAlreadyAnswered: boolean; log?: (line: string) => void },
): RejectionDisposition {
  void opts.confirmAlreadyAnswered;
  const log = opts.log ?? logError;
  const message = reason instanceof Error ? reason.message : String(reason);
  log(`unhandled rejection: ${message}`);
  return "fatal";
}

export function installUnhandledRejectionHandler(
  _log: (line: string) => void = logError,
): void {
  // Confirm catches leftover polls on every path. A process listener would
  // swallow unrelated rejections and print programming errors without a stack.
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
  let stopped = false;
  let leftover: unknown = null;
  let leftoverLogged = false;
  let subId: number | undefined;

  const markAnswered = (): void => {
    answered = true;
  };

  const logLeftover = (err: unknown): void => {
    leftover = leftover ?? err;
    if (leftoverLogged) return;
    leftoverLogged = true;
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
    while (!stopped) {
      if (answered) return;
      try {
        const { value } = await connection.getSignatureStatus(signature);
        if (stopped || answered) return;
        if (value?.err) {
          throw new Error(`transaction ${signature} failed: ${JSON.stringify(value.err)}`);
        }
        if (meetsCommitment(value?.confirmationStatus, commitment)) {
          markAnswered();
          return;
        }
      } catch (err) {
        leftover = err;
        if (stopped || answered) {
          logLeftover(err);
          return;
        }
        throw err;
      }
      if (stopped || answered) return;
      await sleep(POLL_MS);
    }
  })();

  void poll.catch((err) => {
    leftover = leftover ?? err;
    if (answered || stopped) logLeftover(err);
  });

  try {
    const winner = await Promise.race([
      ws.then(() => "ws" as const),
      poll.then(() => "poll" as const).catch((err) => {
        leftover = leftover ?? err;
        return "refused" as const;
      }),
    ]);

    if (winner === "ws" || winner === "poll") {
      if (leftover !== null) logLeftover(leftover);
      return;
    }

    // The endpoint refused to answer. Wait for the websocket during the
    // grace; if it confirms, the refuse is leftover. If it does not, throw
    // the refusal that actually happened. A poll that answered not yet never
    // reaches here: it keeps waiting.
    try {
      await Promise.race([
        ws,
        sleep(graceMs).then(() => {
          throw leftover instanceof Error ? leftover : new Error(String(leftover ?? "confirm status poll failed"));
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
    stopped = true;
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
