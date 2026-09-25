// Deliberately hostile agent for the demo. Real attempts against our own devnet pool.
// Uses only the agent and a separate demo trader. Never loads the owner key.
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAccount, getAccount } from "@solana/spl-token";
import { fetchTradeRule, tradeLedgerPda, type TradeResult, type TradeRuleAccount, type VetoAgent } from "../src/index.js";
import { TRADE_DISCRIMINATOR } from "../src/idl.js";
import { tradeDecisionsFromTx, viewFromRpc } from "../src/events.js";
import { assertExpected, formatTrade, loadDemo, loadKey, mainIfDirect, parseTradeArgs } from "./trade-demo.js";
import { clearsFloor, createBadPool, swapOutsideRule, type Pool } from "./trade-demo-pool.js";

// The regular SDK deliberately pins these accounts. Compose raw instructions
// here so the destination and pool attacks actually reach the program.
export async function attempt(veto: VetoAgent, rule: TradeRuleAccount, amount: bigint, nonce: bigint,
  patch: Partial<Pool> & { destination?: PublicKey } = {}): Promise<TradeResult> {
  const r = { ...rule, ...patch };
  const data = Buffer.alloc(32);
  TRADE_DISCRIMINATOR.copy(data);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(nonce, 24); // min_out stays zero; the program applies the floor.
  const keys = [veto.agent.publicKey, veto.tradeRule!, tradeLedgerPda(veto.programId, veto.tradeRule!),
    r.source, r.destination, r.exchangeProgram, r.pool, r.poolAuthority, r.poolInVault,
    r.poolOutVault, r.poolMint, r.poolFeeAccount, TOKEN_PROGRAM_ID].map((pubkey, index) => ({
      pubkey, isSigner: index === 0, isWritable: [1, 2, 3, 4, 8, 9, 10, 11].includes(index),
    }));
  const latest = await veto.connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: veto.agent.publicKey, ...latest }).add(
    new TransactionInstruction({ programId: veto.programId, keys, data }),
  );
  transaction.sign(veto.agent);
  const signature = await veto.connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "confirmed" });
  const confirmation = await veto.connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) throw new Error(`signature=${signature}: trade transaction failed`);
  for (let i = 0; i < 8; i++) {
    const tx = await veto.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx) {
      const decisions = tradeDecisionsFromTx(viewFromRpc(tx, { signature, slot: tx.slot }), veto.programId.toBase58(), veto.tradeRule!.toBase58())
        .filter(d => d.nonce === nonce && (d.kind === "traded" ? d.amountIn > 0n && d.amountIn <= amount : d.amountIn === amount && d.minOut === 0n));
      if (decisions.length !== 1) throw new Error(`signature=${signature}: expected one attributable trade decision`);
      const d = decisions[0]!;
      return { kind: d.kind, amountIn: d.amountIn, amountOut: d.amountOut, reasonCode: d.reason,
        reasonText: d.reasonText, suggestedOverride: d.suggestedOverride, signature, slot: tx.slot };
    }
    if (i < 7) await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`signature=${signature}: confirmed transaction unavailable`);
}

export function assertPoolEnvironment(rule: TradeRuleAccount, env = process.env): void {
  const expected = { TOKEN_SWAP_POOL: rule.pool, TOKEN_SWAP_AUTHORITY: rule.poolAuthority,
    TOKEN_SWAP_WSOL_VAULT: rule.poolInVault, TOKEN_SWAP_USDC_VAULT: rule.poolOutVault,
    TOKEN_SWAP_POOL_MINT: rule.poolMint, TOKEN_SWAP_FEE_ACCOUNT: rule.poolFeeAccount };
  for (const [name, key] of Object.entries(expected)) {
    if (env[name] !== key.toBase58()) throw new Error(`${name} missing or does not match the live rule`);
  }
}

export async function assertDevnet(veto: VetoAgent): Promise<void> {
  if (await veto.connection.getGenesisHash() !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
    throw new Error("hostile demo requires devnet");
  }
}

mainIfDirect(import.meta.url, async () => {
  console.log("Deliberately hostile agent for the demo: real attempts against our own devnet pool.");
  // The second key path is the final positional argument.
  const argv = process.argv.slice(2);
  const secondKeyFile = argv.pop();
  if (!secondKeyFile) throw new Error("requires a final <second-trader-key.json> argument");
  const args = parseTradeArgs(argv);
  const veto = await loadDemo(args);
  await assertDevnet(veto);
  const rule = await fetchTradeRule(veto.connection, veto.tradeRule!, veto.programId);
  if (!rule.agent.equals(veto.agent.publicKey)) throw new Error("signer is not the rule agent");
  const second = loadKey(secondKeyFile);
  if (second.publicKey.equals(rule.owner) || second.publicKey.equals(veto.agent.publicKey)) throw new Error("second trader must differ from owner and agent");
  assertPoolEnvironment(rule);
  const status = await veto.tradeStatus();
  const small = args.amount;
  if (status.status !== 0 || status.expiresAt <= BigInt(Math.floor(Date.now() / 1000)) ||
      status.overrideAmount !== 0n || status.perTradeMax < 2n * small ||
      status.remainingToday <= status.perTradeMax || status.remaining < status.remainingToday ||
      status.perTradeMax === 0xffffffffffffffffn) {
    throw new Error("requires an active rule without override, 2 * amount <= per-trade max < remaining today, and cap covering today's allowance");
  }
  if (!await clearsFloor(veto.connection, rule, small)) throw new Error("initial pool quote is already below the floor");
  // Increment even after refusals to avoid resubmitting an identical signed transaction.
  let nonce = await veto.nextTradeNonce();
  const check = async (label: string, amount: bigint, reason: number, patch = {}, override = 0n) => {
    if (nonce > 0xffffffffffffffffn) throw new Error("nonce exhausted");
    const result = await attempt(veto, rule, amount, nonce++, patch);
    console.log(`${label} ${formatTrade(result)}`);
    assertExpected(result, reason, override);
    return result;
  };
  const stolenDestination = await createAccount(veto.connection, veto.agent, rule.outMint, veto.agent.publicKey);
  await check("a.destination", small, 11, { destination: stolenDestination });
  const evilPool = await createBadPool(veto.connection, veto.agent, rule, small);
  await check("b.pool", small, 12, evilPool);
  await check("c.per_trade", status.perTradeMax + 1n, 5, {}, status.perTradeMax + 1n);

  // Leave 'small' available for e/f. The daily refusal requests max, not the
  // remaining allowance. Re-read actual settled input, including curve rounding.
  for (let count = 0; ; count++) {
    if (count >= 1000) throw new Error("daily attempt safety bound reached; use a larger per-trade maximum");
    const today = (await veto.tradeStatus()).remainingToday;
    if (today < small) throw new Error("daily allowance changed during demo");
    if (today < status.perTradeMax) {
      await check("d.daily", status.perTradeMax, 13);
      break;
    }
    const amount = today - small < status.perTradeMax ? today - small : status.perTradeMax;
    await check("d.fill", amount, 0);
  }

  // Move the pinned pool using a second signer and its own input funds.
  // Reverse only the output received by these swaps before the honest trade.
  let received = 0n;
  let shift = (await getAccount(veto.connection, rule.poolInVault)).amount;
  for (let i = 0; await clearsFloor(veto.connection, rule, small); i++) {
    if (i >= 16 || shift > 0xffffffffffffffffn) throw new Error("could not move pool below floor within demo bound");
    received += await swapOutsideRule(veto.connection, second, rule, shift);
    shift *= 2n;
  }
  if (received === 0n) throw new Error("pool changed before third-party swap");
  await check("e.floor", small, 14);
  await swapOutsideRule(veto.connection, second, rule, received, true);
  if (!await clearsFloor(veto.connection, rule, small)) throw new Error("restored pool still below floor");
  await check("f.honest", small, 0);
});
