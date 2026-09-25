import { homedir } from "node:os";
import { stderr as processStderr, stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { renderQr } from "./qr.js";
import { Connection, type Connection as Chain } from "./web3.js";

export type Runtime = {
  home: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  connect: (rpcUrl: string) => Chain;
  qr: (text: string) => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  ask: (prompt: string) => Promise<string>;
  /** Polls before connect gives up. The real command waits until a rule appears. */
  maxPolls: number;
};

function writeLine(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function productionRuntime(): Runtime & { close(): void } {
  let rl: Interface | undefined;
  return {
    home: homedir(),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    connect: (rpcUrl) => new Connection(rpcUrl, "confirmed"),
    qr: renderQr,
    stdout: (text) => writeLine(processStdout, text),
    stderr: (text) => writeLine(processStderr, text),
    async ask(prompt) {
      rl ??= createInterface({ input: processStdin, output: processStdout });
      return rl.question(`${prompt}: `);
    },
    maxPolls: Number.POSITIVE_INFINITY,
    close() {
      rl?.close();
    },
  };
}
