import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Cluster } from "./cluster.js";
import { CliError } from "./errors.js";
import { Keypair, type Keypair as AgentKey } from "./web3.js";

export type VetoConfig = {
  rule: string;
  rpc: string;
  cluster: Cluster;
  key: string;
};

export function vetoDir(home: string): string {
  return join(home, ".veto");
}

export function agentFile(home: string): string {
  return join(vetoDir(home), "agent.json");
}

export function configFile(home: string): string {
  return join(vetoDir(home), "config.json");
}

/** Refuse to start when the agent key mode is wider than 0600. Does not read the file. */
export async function assertAgentKeyMode(home: string): Promise<void> {
  const file = agentFile(home);
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "ENOENT") return;
    throw new CliError("The agent key file could not be checked.");
  }
  if (!info.isFile()) {
    throw new CliError("The agent key file must be a regular file.");
  }
  const bits = info.mode & 0o7777;
  if ((bits & ~0o600) !== 0) {
    const shown = bits.toString(8).padStart(4, "0");
    throw new CliError(`The agent key file mode is ${shown}, which is wider than 0600.`);
  }
}

export async function writeKeyFile(file: string, secret: Uint8Array): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(file, `${JSON.stringify(Array.from(secret))}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readKeyFile(file: string): Promise<AgentKey> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "ENOENT") throw new CliError("Agent key file not found.", "key-missing");
    throw new CliError("Agent key file could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("Agent key file is not a JSON secret key array.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(isSecretByte)) {
    throw new CliError("Agent key file is not a 64-byte secret key.");
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    throw new CliError("Agent key file is not a 64-byte secret key.");
  }
}

export async function loadOrCreateKey(
  home: string,
  keyFlag: string | undefined,
): Promise<{ keypair: AgentKey; path: string }> {
  if (keyFlag !== undefined) {
    const path = resolve(keyFlag);
    return { keypair: await readKeyFile(path), path };
  }
  const path = agentFile(home);
  try {
    return { keypair: await readKeyFile(path), path };
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== "key-missing") throw err;
  }
  const keypair = Keypair.generate();
  await writeKeyFile(path, keypair.secretKey);
  return { keypair, path };
}

export async function writeConfig(home: string, config: VetoConfig): Promise<void> {
  const dir = vetoDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const body = `${JSON.stringify(
    { rule: config.rule, rpc: config.rpc, cluster: config.cluster, key: config.key },
    null,
    2,
  )}\n`;
  const file = configFile(home);
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readConfig(home: string): Promise<VetoConfig> {
  let text: string;
  try {
    text = await readFile(configFile(home), "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "ENOENT") throw new CliError("Run veto connect first.", "config-missing");
    throw new CliError("The veto config could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("The veto config could not be read.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("The veto config could not be read.");
  }
  const record = parsed as Record<string, unknown>;
  const { rule, rpc, cluster, key } = record;
  if (typeof rule !== "string" || rule.length === 0 || typeof rpc !== "string" || rpc.length === 0) {
    throw new CliError("The veto config could not be read.");
  }
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new CliError("The veto config could not be read.");
  }
  const keyPath = typeof key === "string" && key.length > 0 ? key : agentFile(home);
  return { rule, rpc, cluster, key: keyPath };
}

function isSecretByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}
