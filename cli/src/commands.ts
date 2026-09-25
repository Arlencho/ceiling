import {
  LOW_FEE_LAMPORTS,
  RuleRequestRejected,
  VetoAgent,
  createRuleRequest,
  decisionsForMandate,
  mandatesForAgent,
} from "@veto-hq/agent-sdk";
import type { Decision } from "@veto-hq/agent-sdk";
import { USAGE, parseArgs, rejectPositionals, rejectUnused, type Args } from "./args.js";
import { DEFAULT_RPC, assertGenesis, explorerTx, parseCluster, type Cluster } from "./cluster.js";
import { CliError, FILTERS_REFUSED, isForeignAgent, rpcRefusesFilters } from "./errors.js";
import { loadOrCreateKey, readConfig, readKeyFile, writeConfig } from "./files.js";
import {
  DEVNET_USDC_MINT,
  MCP_CONFIG_LINE,
  approvedSentence,
  formatTokenUnits,
  formatUnits,
  formatUtcDay,
  isActive,
  parseBaseUnits,
  parseDays,
  readDecimals,
  tokenSymbol,
  unixSeconds,
} from "./money.js";
import type { Runtime } from "./runtime.js";
import { PublicKey, canonicalAddress, type Connection, type Keypair as AgentKey, type PublicKey as Address } from "./web3.js";

const POLL_MS = 5_000;
const AIRDROP_LAMPORTS = 1_000_000_000;
const CONNECT_FLAGS = ["key", "rule", "payee", "mint", "max", "cap", "days", "purpose", "rpc", "cluster"] as const;

type RuleFields = {
  payee: string;
  max: string;
  cap: string;
  days: string;
  purpose: string;
  mint: string;
};

export async function run(argv: readonly string[], runtime: Runtime): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      runtime.stdout(USAGE);
      return 0;
    }
    if (args.command === "trade") {
      throw new CliError("veto trade arrives with the trade rule.");
    }
    if (args.command === "connect") await connect(args, runtime);
    else if (args.command === "pay") await pay(args, runtime);
    else if (args.command === "status") await status(args, runtime);
    else if (args.command === "decisions") await decisions(args, runtime);
    else throw new CliError(`Unknown command ${args.command}.`);
    return 0;
  } catch (err) {
    runtime.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function connect(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, CONNECT_FLAGS);
  rejectPositionals(args);
  const cluster = parseCluster(args.cluster);
  const rpc = args.rpc?.trim() || DEFAULT_RPC[cluster];
  const loaded = await loadOrCreateKey(runtime.home, args.key);
  runtime.stdout(`Agent ${loaded.keypair.publicKey.toBase58()}`);
  runtime.stdout("This key lives on your machine. Veto never holds it.");
  const connection = runtime.connect(rpc);
  await assertGenesis(connection, cluster);
  await maybeAirdrop(connection, loaded.keypair.publicKey, cluster, runtime);
  const address =
    args.rule !== undefined
      ? await namedRule(connection, args.rule, loaded.keypair, runtime)
      : await requestAndWait(connection, loaded.keypair, cluster, args, runtime);
  await showRule(connection, address, loaded.keypair, runtime);
  await writeConfig(runtime.home, { rule: address, rpc, cluster, key: loaded.path });
}

async function pay(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, ["rule"]);
  if (args.positionals.length !== 1) {
    throw new CliError("Usage: veto pay <amount in base units> [--rule <address>].");
  }
  const amountText = args.positionals[0];
  if (amountText === undefined) {
    throw new CliError("Usage: veto pay <amount in base units> [--rule <address>].");
  }
  const amount = parseBaseUnits(amountText, "Amount");
  const stored = await readConfig(runtime.home);
  const keypair = await readKeyFile(stored.key);
  const connection = runtime.connect(stored.rpc);
  const address = await selectRule(connection, keypair, runtime, args.rule);
  const veto = await openMandate(connection, address, keypair);
  const view = await veto.status();
  if (!isActive(view.status, view.expiresAt, unixSeconds(runtime.now()))) {
    throw new CliError("No active rule.");
  }
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  const symbol = tokenSymbol(view.mint);
  const nonce = await veto.nextNonce();
  const outcome = await veto.charge({ amount, nonce, guardPendingOverride: true });
  runtime.stdout(`kind ${outcome.kind}`);
  runtime.stdout(`reason ${outcome.reasonCode} ${outcome.reasonText}`);
  runtime.stdout(`override ${formatTokenUnits(outcome.suggestedOverride, decimals)} ${symbol}`);
  runtime.stdout(`signature ${outcome.signature}`);
  runtime.stdout(explorerTx(outcome.signature, stored.cluster));
}

async function status(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, []);
  rejectPositionals(args);
  const { connection, veto } = await openSaved(runtime);
  const view = await veto.status();
  if (!isActive(view.status, view.expiresAt, unixSeconds(runtime.now()))) {
    throw new CliError("No active rule.");
  }
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  const symbol = tokenSymbol(view.mint);
  runtime.stdout(`Can still pay ${formatTokenUnits(view.remaining, decimals)} ${symbol} today`);
  runtime.stdout(`Cap ${formatTokenUnits(view.cap, decimals)} ${symbol}`);
  runtime.stdout(`Largest payment ${formatTokenUnits(view.perTxMax, decimals)} ${symbol}`);
  runtime.stdout(`Ends ${formatUtcDay(view.expiresAt)}`);
  runtime.stdout(`Fee SOL ${formatUnits(view.agentLamports, 9)}`);
  if (view.feeWarning) runtime.stdout(view.feeWarning);
}

async function decisions(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, ["limit"]);
  rejectPositionals(args);
  const limit = parseLimit(args.limit);
  const { connection, veto } = await openSaved(runtime);
  const view = await veto.status();
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  const symbol = tokenSymbol(view.mint);
  const page = await decisionsForMandate(
    connection,
    veto.mandate,
    limit === undefined ? undefined : { limit },
  );
  const rows = [...page].reverse();
  if (rows.length === 0) {
    runtime.stdout("No decisions.");
    return;
  }
  for (const row of rows) runtime.stdout(decisionLine(row, decimals, symbol));
}

async function maybeAirdrop(
  connection: Connection,
  owner: Address,
  cluster: Cluster,
  runtime: Runtime,
): Promise<void> {
  if (cluster !== "devnet") return;
  const balance = await connection.getBalance(owner, "confirmed");
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new CliError("Could not read the agent SOL balance.");
  }
  if (BigInt(balance) >= LOW_FEE_LAMPORTS) return;
  const signature = await connection.requestAirdrop(owner, AIRDROP_LAMPORTS);
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) throw new CliError("The devnet airdrop failed.");
  runtime.stdout("Requested an airdrop. This devnet key held under 20 base fees of SOL.");
}

async function namedRule(
  connection: Connection,
  rule: string,
  keypair: AgentKey,
  runtime: Runtime,
): Promise<string> {
  const address = canonicalAddress(rule, "Rule address");
  const veto = await openMandate(connection, address, keypair);
  const view = await veto.status();
  if (!isActive(view.status, view.expiresAt, unixSeconds(runtime.now()))) {
    throw new CliError("This rule is not active.");
  }
  return address;
}

async function requestAndWait(
  connection: Connection,
  keypair: AgentKey,
  cluster: Cluster,
  args: Args,
  runtime: Runtime,
): Promise<string> {
  const fields = await askRule(args, cluster, runtime);
  let url: string;
  try {
    url = createRuleRequest({
      agent: keypair.publicKey.toBase58(),
      payee: fields.payee.trim(),
      mint: fields.mint.trim(),
      cap: parseBaseUnits(fields.cap, "Total"),
      max: parseBaseUnits(fields.max, "Most per payment"),
      days: parseDays(fields.days),
      purpose: fields.purpose.trim(),
    });
  } catch (err) {
    if (err instanceof RuleRequestRejected || err instanceof CliError) {
      throw new CliError(err.message);
    }
    throw err;
  }
  runtime.stdout(url);
  runtime.stdout(runtime.qr(url));
  runtime.stdout("Waiting for you to approve on the phone.");
  for (let poll = 0; poll < runtime.maxPolls; poll += 1) {
    let rules;
    try {
      rules = await mandatesForAgent(connection, keypair.publicKey);
    } catch (err) {
      if (rpcRefusesFilters(err)) throw new CliError(FILTERS_REFUSED);
      throw err;
    }
    const now = unixSeconds(runtime.now());
    const match = rules.find(
      (rule) => rule.agent.equals(keypair.publicKey) && isActive(rule.status, rule.expiresAt, now),
    );
    if (match) return match.address.toBase58();
    await runtime.sleep(POLL_MS);
  }
  throw new CliError("Still waiting for you to approve on the phone.");
}

async function askRule(args: Args, cluster: Cluster, runtime: Runtime): Promise<RuleFields> {
  const payee = await givenOrAsk(args.payee, "Payee address", runtime);
  const max = await givenOrAsk(args.max, "Most per payment, in base units", runtime);
  const cap = await givenOrAsk(args.cap, "Total, in base units", runtime);
  const days = await givenOrAsk(args.days, "Days", runtime);
  const purpose = await givenOrAsk(args.purpose, "Purpose", runtime);
  const mint =
    args.mint !== undefined
      ? args.mint
      : cluster === "devnet"
        ? DEVNET_USDC_MINT
        : await runtime.ask("Mint address");
  return { payee, max, cap, days, purpose, mint };
}

async function givenOrAsk(value: string | undefined, prompt: string, runtime: Runtime): Promise<string> {
  if (value !== undefined) return value;
  return runtime.ask(prompt);
}

async function showRule(
  connection: Connection,
  address: string,
  keypair: AgentKey,
  runtime: Runtime,
): Promise<void> {
  const veto = await openMandate(connection, address, keypair);
  const view = await veto.status();
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  runtime.stdout(
    approvedSentence({
      cap: view.cap,
      max: view.perTxMax,
      decimals,
      symbol: tokenSymbol(view.mint),
      expiresAt: view.expiresAt,
      payee: view.merchant,
    }),
  );
  runtime.stdout(MCP_CONFIG_LINE);
}

async function selectRule(
  connection: Connection,
  keypair: AgentKey,
  runtime: Runtime,
  named: string | undefined,
): Promise<string> {
  if (named !== undefined) return canonicalAddress(named, "Rule address");
  let rules;
  try {
    rules = await mandatesForAgent(connection, keypair.publicKey);
  } catch (err) {
    if (rpcRefusesFilters(err)) throw new CliError(FILTERS_REFUSED);
    throw err;
  }
  const now = unixSeconds(runtime.now());
  const match = rules.find(
    (rule) => rule.agent.equals(keypair.publicKey) && isActive(rule.status, rule.expiresAt, now),
  );
  if (!match) throw new CliError("No active rule.");
  return match.address.toBase58();
}

async function openSaved(runtime: Runtime): Promise<{ connection: Connection; veto: VetoAgent }> {
  const stored = await readConfig(runtime.home);
  const keypair = await readKeyFile(stored.key);
  const connection = runtime.connect(stored.rpc);
  const veto = await openMandate(connection, stored.rule, keypair);
  return { connection, veto };
}

async function openMandate(connection: Connection, address: string, keypair: AgentKey): Promise<VetoAgent> {
  try {
    return await VetoAgent.fromMandate(connection, address, keypair);
  } catch (err) {
    if (isForeignAgent(err)) throw new CliError("This key is not the rule's agent.");
    throw err;
  }
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new CliError("Limit must be a whole number from 1 to 1000.");
  }
  const limit = Number(trimmed);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new CliError("Limit must be a whole number from 1 to 1000.");
  }
  return limit;
}

function decisionLine(row: Decision, decimals: number, symbol: string): string {
  return `${row.kind} ${formatTokenUnits(row.amount, decimals)} ${symbol} ${row.reasonText} ${row.signature}`;
}
