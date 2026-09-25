// SPL token-swap v2 wire layout, matching scripts/devnet-token-swap-pool.ts.
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, type Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, createAccount, createMint, getAccount,
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction, createTransferInstruction,
} from "@solana/spl-token";
import type { TradeRuleAccount } from "../src/index.js";

export type Pool = Pick<TradeRuleAccount, "pool" | "poolAuthority" | "poolInVault" | "poolOutVault" | "poolMint" | "poolFeeAccount">;
export const FEE_OWNER = new PublicKey("HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN");
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

// SPL setup helpers return addresses, so capture their submitted signatures here.
// Use a separate connection view to avoid changing the caller's connection.
export function setupConnection(connection: Connection, label: string, print = console.log): Connection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === "sendTransaction") {
        return async (...args: Parameters<Connection["sendTransaction"]>) => {
          const signature = await target.sendTransaction(...args);
          print(`setup=${label} signature=${signature}`);
          return signature;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function initializeData(bump: number): Buffer {
  if (!Number.isInteger(bump) || bump < 0 || bump > 255) throw new Error("invalid bump");
  const data = Buffer.alloc(99);
  data[1] = bump;
  [25n, 10000n, 5n, 10000n, 0n, 0n, 20n, 100n].forEach((fee, i) => data.writeBigUInt64LE(fee, 2 + 8 * i));
  return data;
}

export async function fundedAccount(connection: Connection, payer: Keypair, mint: PublicKey, amount: bigint) {
  const account = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  if (account.amount < amount && mint.equals(NATIVE_MINT)) {
    const needed = amount - account.amount;
    if (needed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("wrapped SOL funding exceeds safe integer");
    await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: account.address, lamports: Number(needed) }),
      createSyncNativeInstruction(account.address),
    ), [payer], { commitment: "confirmed" });
  } else if (account.amount < amount) {
    throw new Error(`demo signer needs ${amount} base units of mint ${mint.toBase58()} in its associated token account`);
  }
  return account.address;
}

export async function createBadPool(connection: Connection, agent: Keypair, rule: TradeRuleAccount, amount: bigint): Promise<Pool> {
  const swap = Keypair.generate();
  const [authority, bump] = PublicKey.findProgramAddressSync([swap.publicKey.toBuffer()], rule.exchangeProgram);
  // One output unit against enough input to be strictly below the rule floor.
  const badInput = 2n * rule.floorDen / rule.floorNum + amount;
  if (badInput > 0xffffffffffffffffn) throw new Error("bad pool seed exceeds u64");
  const source = await fundedAccount(connection, agent, rule.inMint, badInput);
  const output = await fundedAccount(connection, agent, rule.outMint, 1n);
  const inVault = await createAccount(connection, agent, rule.inMint, authority, Keypair.generate());
  const outVault = await createAccount(connection, agent, rule.outMint, authority, Keypair.generate());
  const mint = await createMint(connection, agent, authority, null, 6);
  const fee = await createAccount(connection, agent, mint, FEE_OWNER, Keypair.generate());
  const lp = await createAccount(connection, agent, mint, agent.publicKey, Keypair.generate());
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createTransferInstruction(source, inVault, agent.publicKey, badInput),
    createTransferInstruction(output, outVault, agent.publicKey, 1n),
    SystemProgram.createAccount({ fromPubkey: agent.publicKey, newAccountPubkey: swap.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(324), space: 324, programId: rule.exchangeProgram }),
    new TransactionInstruction({ programId: rule.exchangeProgram, data: initializeData(bump), keys: [
      meta(swap.publicKey, true, true), meta(authority), meta(inVault), meta(outVault),
      meta(mint, true), meta(fee), meta(lp, true), meta(TOKEN_PROGRAM_ID),
    ] }),
  ), [agent, swap], { commitment: "confirmed" });
  return { pool: swap.publicKey, poolAuthority: authority, poolInVault: inVault,
    poolOutVault: outVault, poolMint: mint, poolFeeAccount: fee };
}

export function quote(amount: bigint, input: bigint, output: bigint): bigint {
  const fee = (num: bigint) => amount * num / 10000n > 0n ? amount * num / 10000n : 1n;
  const net = amount - fee(25n) - fee(5n);
  return net > 0n ? net * output / (input + net) : 0n;
}

export async function clearsFloor(connection: Connection, rule: TradeRuleAccount, amount: bigint) {
  const input = await getAccount(connection, rule.poolInVault);
  const output = await getAccount(connection, rule.poolOutVault);
  return quote(amount, input.amount, output.amount) * rule.floorDen >= amount * rule.floorNum;
}

export async function swapOutsideRule(connection: Connection, signer: Keypair, rule: TradeRuleAccount, amount: bigint, reverse = false) {
  const setup = setupConnection(connection, reverse ? "restore" : "lower");
  const source = await fundedAccount(setup, signer, reverse ? rule.outMint : rule.inMint, amount);
  const dest = await fundedAccount(setup, signer, reverse ? rule.inMint : rule.outMint, 0n);
  const before = (await getAccount(connection, dest)).amount;
  const data = Buffer.alloc(17);
  data[0] = 1;
  data.writeBigUInt64LE(amount, 1);
  data.writeBigUInt64LE(1n, 9);
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(new TransactionInstruction({
    programId: rule.exchangeProgram, data, keys: [
      meta(rule.pool), meta(rule.poolAuthority), meta(signer.publicKey, false, true), meta(source, true),
      meta(reverse ? rule.poolOutVault : rule.poolInVault, true),
      meta(reverse ? rule.poolInVault : rule.poolOutVault, true), meta(dest, true),
      meta(rule.poolMint, true), meta(rule.poolFeeAccount, true), meta(TOKEN_PROGRAM_ID),
    ],
  })), [signer], { commitment: "confirmed" });
  console.log(`third_party_swap direction=${reverse ? "restore" : "lower"} signature=${signature}`);
  return (await getAccount(connection, dest)).amount - before;
}
