import { createWriteStream } from "node:fs";
import type { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { generate, toNdjsonLine, type GenConfig } from "./gen.js";

const USAGE = `Usage: tsx src/cli.ts [options]

Synthetic veto transaction generator. Writes newline-delimited JSON, one
TxView per line, to stdout or to --out.

Options:
  --agents <n>        number of agents (default 4)
  --rules <n>         rule profiles per agent, one mandate each (default 2)
  --transactions <n>  charge and override transactions to emit (default 100)
  --paid <w>          mix weight for paid charges (default 70)
  --refused <w>       mix weight for refused charges (default 25)
  --override <w>      mix weight for grant_override calls (default 5)
  --seed <n>          deterministic seed (default 1)
  --start-slot <n>    slot of the first transaction (default 250000000)
  --start-time <n>    blockTime of the first transaction, unix seconds
  --out <path>        write to a file instead of stdout
  --help              show this text
`;

export function parseCli(argv: string[]): GenConfig & { out?: string; help?: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      agents: { type: "string", default: "4" },
      rules: { type: "string", default: "2" },
      transactions: { type: "string", default: "100" },
      paid: { type: "string", default: "70" },
      refused: { type: "string", default: "25" },
      override: { type: "string", default: "5" },
      seed: { type: "string", default: "1" },
      "start-slot": { type: "string" },
      "start-time": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const num = (name: string, value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${JSON.stringify(value)}`);
    return n;
  };
  return {
    agents: num("agents", values.agents)!,
    rules: num("rules", values.rules)!,
    transactions: num("transactions", values.transactions)!,
    paid: num("paid", values.paid)!,
    refused: num("refused", values.refused)!,
    override: num("override", values.override)!,
    seed: num("seed", values.seed)!,
    startSlot: num("start-slot", values["start-slot"]),
    startTime: num("start-time", values["start-time"]),
    out: values.out,
    help: values.help,
  };
}

async function writeBatch(config: GenConfig, stream: Writable): Promise<void> {
  for (const { tx } of generate(config)) {
    if (!stream.write(`${toNdjsonLine(tx)}\n`)) {
      await new Promise<void>((resolve) => stream.once("drain", resolve));
    }
  }
}

export async function run(argv: string[], stdout: Writable): Promise<void> {
  const config = parseCli(argv);
  if (config.help) {
    stdout.write(USAGE);
    return;
  }
  if (!config.out) {
    await writeBatch(config, stdout);
    return;
  }
  const file = createWriteStream(config.out);
  try {
    await writeBatch(config, file);
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  run(process.argv.slice(2), process.stdout).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
