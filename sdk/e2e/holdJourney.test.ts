// Hold journey through the SDK HoldVault client only.
//
// Skipped unless VETO_E2E=1, so `npm test` does not touch a cluster.
// VETO_RPC names the cluster (local validator or devnet). VETO_CLUSTER is
// `localnet` or `devnet`.
//
// The program accepts a delay of 1, 2, or 3 days and nothing shorter. On
// localnet the harness warps solana-test-validator once (HOLD_E2E_LEDGER and
// HOLD_E2E_WARP_SLOT). Slot 300000 moves Clock.unix_timestamp about 25 hours
// ahead of genesis on solana-test-validator 4.1, which covers one 1 day
// delay. A second warp does not reload: the snapshot taken after a warp
// fails with a leader id mismatch. The loosening change is therefore shown
// waiting, and applying it after its own delay is left for a devnet run that
// can sit out the real clock.
//
// On devnet there is no warp. Execute is refused before unlock, and the
// payment after unlock is not claimed in that run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { HoldVault } from "../src/hold.js";
import { PROGRAM_ID } from "../src/idl.js";

const ENABLED = process.env.VETO_E2E === "1";
const RPC = process.env.VETO_RPC?.trim() ?? "";
const CLUSTER = process.env.VETO_CLUSTER?.trim() || inferredCluster(RPC);
const PROGRAM = new PublicKey(process.env.VETO_PROGRAM_ID?.trim() || PROGRAM_ID.toBase58());
const LEDGER = process.env.HOLD_E2E_LEDGER?.trim() ?? "";
const WARP_SLOT = process.env.HOLD_E2E_WARP_SLOT?.trim() || "300000";

const DAY = 86_400n;
const DECIMALS = 6;
const DEPOSIT = 1_000_000_000n;
const DAILY = 100_000_000n;
const TIGHT_DAILY = 40_000_000n;
const SHARE = 2_500;
const LOOSE_SHARE = 5_000;
const ARM = 1_000_000n;
const EVERYDAY = 10_000_000n;
const BIG = 300_000_000n;
const STOP_AMOUNT = 50_000_000n;
const VAULT_ID = 1n;
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

const CHANGE_SHARE = 4;

function inferredCluster(rpc: string): string {
  if (rpc.includes("127.0.0.1") || rpc.includes("localhost")) return "localnet";
  return "devnet";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      const extra = current as Error & { logs?: string[]; transactionLogs?: string[] };
      if (extra.logs) parts.push(...extra.logs);
      if (extra.transactionLogs) parts.push(...extra.transactionLogs);
      current = extra.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n");
}

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const text = errorText(err);
      const transient = /blockhash|Blockhash not found|timeout|timed out|fetch failed|ECONNREFUSED|ECONNRESET|429|not deployed|Node is behind/i.test(
        text,
      );
      if (!transient || attempt === 5) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(`${label} failed`);
}

async function airdrop(connection: Connection, pubkey: PublicKey, sol: number): Promise<void> {
  await retry(`airdrop ${pubkey.toBase58()}`, async () => {
    const signature = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash("confirmed");
    const confirmed = await connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed",
    );
    if (confirmed.value.err) {
      throw new Error(`airdrop failed: ${JSON.stringify(confirmed.value.err)}`);
    }
  });
}

async function tokenAmount(connection: Connection, address: PublicKey): Promise<bigint> {
  const account = await getAccount(connection, address, "confirmed");
  return account.amount;
}

async function chainNow(connection: Connection): Promise<bigint> {
  // Processed, not confirmed. A warp slot keeps the parent timestamp. The
  // next slots correct it, and that is the clock a transaction executes
  // against. Confirmed can still be the warp slot for a moment.
  const info = await connection.getAccountInfo(CLOCK, "processed");
  if (!info) throw new Error("clock sysvar is missing");
  return info.data.readBigInt64LE(32);
}

async function waitForClock(connection: Connection, target: bigint): Promise<bigint> {
  let now = 0n;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    now = await chainNow(connection);
    if (now >= target) return now;
    await sleep(250);
  }
  return now;
}

async function chainSlot(connection: Connection): Promise<number> {
  return connection.getSlot("confirmed");
}

function newestSnapshot(ledger: string): { slot: number; bytes: number } {
  let slot = 0;
  let bytes = 0;
  for (const name of readdirSync(ledger)) {
    const match = /^snapshot-(\d+)-.+\.tar\.zst$/.exec(name);
    const parsed = match?.[1];
    if (!parsed) continue;
    const height = Number(parsed);
    if (height < slot) continue;
    slot = height;
    bytes = statSync(join(ledger, name)).size;
  }
  return { slot, bytes };
}

// solana-test-validator writes a full snapshot every 100 slots and a warp
// reloads that snapshot, not the live bank. Wait until one exists at or
// after the journey's last confirmed slot, and until its size stops changing.
async function waitForSnapshot(ledger: string, minSlot: number): Promise<number> {
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const found = newestSnapshot(ledger);
    if (found.slot >= minSlot && found.bytes > 0) {
      if (found.bytes === previous) {
        stable += 1;
        if (stable >= 2) return found.slot;
      } else {
        stable = 0;
        previous = found.bytes;
      }
    }
    await sleep(500);
  }
  throw new Error(`no stable snapshot at or after slot ${minSlot} in ${ledger}`);
}

function warpLocalClock(slot: string): void {
  const script = fileURLToPath(new URL("../../scripts/hold-e2e.sh", import.meta.url));
  const result = spawnSync("bash", [script, "warp", slot], {
    encoding: "utf8",
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    throw new Error(`clock warp failed (${result.status ?? "no status"}): ${output}`);
  }
}

function isTransient(err: unknown): boolean {
  return /blockhash|Blockhash not found|timeout|timed out|fetch failed|ECONNREFUSED|ECONNRESET|Node is behind/i.test(
    errorText(err),
  );
}

async function expectRefuse(label: string, fn: () => Promise<unknown>, needles: string[]): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fn();
    } catch (err) {
      if (isTransient(err) && attempt < 4) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      const text = errorText(err);
      const hit = needles.some((needle) => text.toLowerCase().includes(needle.toLowerCase()));
      assert.ok(hit, `${label} failed without ${needles.join(" or ")}:\n${text}`);
      return;
    }
    assert.fail(`${label}: the transaction succeeded`);
  }
}

test(
  "a Hold vault pays a known everyday withdrawal at once, holds a big one, and lets the guardian stop, freeze, and recover",
  { skip: !ENABLED, timeout: 300_000 },
  async () => {
    assert.ok(RPC, "VETO_RPC is required when VETO_E2E=1");
    const local = CLUSTER === "localnet";
    if (local && LEDGER === "") {
      throw new Error("localnet Hold journey needs HOLD_E2E_LEDGER so it can warp the validator clock");
    }

    const connection = new Connection(RPC, "confirmed");
    const hold = new HoldVault({ connection, programId: PROGRAM });
    const owner = Keypair.generate();
    const guardian = Keypair.generate();
    const safe = Keypair.generate();
    const payee = Keypair.generate();
    const stranger = Keypair.generate();
    const other = Keypair.generate();

    await airdrop(connection, owner.publicKey, 10);
    await airdrop(connection, guardian.publicKey, 2);
    await airdrop(connection, stranger.publicKey, 2);

    const mint = await retry("create mint", () =>
      createMint(connection, owner, owner.publicKey, null, DECIMALS),
    );
    const source = await createAssociatedTokenAccountIdempotent(connection, owner, mint, owner.publicKey);
    const payeeAta = await createAssociatedTokenAccountIdempotent(connection, owner, mint, payee.publicKey);
    const otherAta = await createAssociatedTokenAccountIdempotent(connection, owner, mint, other.publicKey);
    const safeAta = await createAssociatedTokenAccountIdempotent(connection, owner, mint, safe.publicKey);
    await retry("mint to owner", () => mintTo(connection, owner, mint, source, owner, DEPOSIT));

    const opened = await retry("init vault", () =>
      hold.initVault({
        owner,
        vaultId: VAULT_ID,
        guardian: guardian.publicKey,
        safeAddress: safe.publicKey,
        dailyLimit: DAILY,
        delaySecs: DAY,
        bigShareBps: SHARE,
        mint,
      }),
    );
    let view = await hold.fetchVault(opened.vault);
    assert.equal(view.guardian.equals(guardian.publicKey), true);
    assert.equal(view.safeAddress.equals(safe.publicKey), true);
    assert.equal(view.frozen, false);
    assert.equal(view.known.length, 0);
    assert.equal(view.dailyLimit, DAILY);
    assert.equal(view.delaySecs, DAY);
    assert.equal(view.bigShareBps, SHARE);

    await hold.deposit({
      owner,
      vaultId: VAULT_ID,
      source,
      mint,
      amount: DEPOSIT,
    });
    assert.equal(await tokenAmount(connection, opened.vaultToken), DEPOSIT);

    // The known list starts empty, so the first payment to an address is held
    // even when it is small. Both keys skip that hold, which pays it now and
    // remembers the address. The everyday withdrawal below is the one that
    // must pay at once.
    const armed = await hold.withdraw({
      owner,
      vaultId: VAULT_ID,
      destination: payeeAta,
      mint,
      amount: ARM,
    });
    view = await hold.fetchVault(armed.vault);
    assert.equal(view.pending.length, 1);
    const armRow = view.pending[0];
    assert.ok(armRow);
    assert.equal(armRow.destination.equals(payeeAta), true);
    assert.equal(await tokenAmount(connection, payeeAta), 0n);
    assert.equal(await tokenAmount(connection, opened.vaultToken), DEPOSIT);

    await hold.skip({
      owner,
      guardian,
      vaultId: VAULT_ID,
      destination: payeeAta,
      mint,
      id: armRow.id,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.pending.length, 0);
    assert.equal(view.known.some((key) => key.equals(payeeAta)), true);
    assert.equal(await tokenAmount(connection, payeeAta), ARM);
    assert.equal(await tokenAmount(connection, opened.vaultToken), DEPOSIT - ARM);

    const beforeEveryday = await tokenAmount(connection, opened.vaultToken);
    await hold.withdraw({
      owner,
      vaultId: VAULT_ID,
      destination: payeeAta,
      mint,
      amount: EVERYDAY,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.pending.length, 0);
    assert.equal(await tokenAmount(connection, opened.vaultToken), beforeEveryday - EVERYDAY);
    assert.equal(await tokenAmount(connection, payeeAta), ARM + EVERYDAY);

    const beforeBig = await tokenAmount(connection, opened.vaultToken);
    const payeeBeforeBig = await tokenAmount(connection, payeeAta);
    const clockBeforeBig = await chainNow(connection);
    await hold.withdraw({
      owner,
      vaultId: VAULT_ID,
      destination: payeeAta,
      mint,
      amount: BIG,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.pending.length, 1);
    const big = view.pending[0];
    assert.ok(big);
    assert.equal(big.amount, BIG);
    assert.equal(big.destination.equals(payeeAta), true);
    assert.equal(big.unlockAt >= clockBeforeBig + DAY, true);
    assert.equal(await tokenAmount(connection, opened.vaultToken), beforeBig);
    assert.equal(await tokenAmount(connection, payeeAta), payeeBeforeBig);

    await expectRefuse(
      "execute before unlock",
      () =>
        hold.execute({
          payer: stranger,
          owner: owner.publicKey,
          vaultId: VAULT_ID,
          destination: payeeAta,
          mint,
          id: big.id,
        }),
      ["TooEarly", "0x1797", "6039", "has not reached the unlock time"],
    );
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.pending.length, 1);
    assert.equal(view.pending[0]?.id, big.id);
    assert.equal(await tokenAmount(connection, opened.vaultToken), beforeBig);
    assert.equal(await tokenAmount(connection, payeeAta), payeeBeforeBig);

    let paidAfter = "not run (devnet does not warp; unlock is one day out)";
    if (local) {
      const slotBefore = await chainSlot(connection);
      assert.equal(slotBefore < Number(WARP_SLOT), true, `slot ${slotBefore} is already at the warp target`);
      const snap = await waitForSnapshot(LEDGER, slotBefore);
      assert.equal(snap >= slotBefore, true);
      warpLocalClock(WARP_SLOT);
      const now = await waitForClock(connection, big.unlockAt);
      assert.equal(
        now >= big.unlockAt,
        true,
        `warp to slot ${WARP_SLOT} left the clock at ${now}, unlock is ${big.unlockAt}`,
      );
      await retry("execute after warp", () =>
        hold.execute({
          payer: stranger,
          owner: owner.publicKey,
          vaultId: VAULT_ID,
          destination: payeeAta,
          mint,
          id: big.id,
        }),
      );
      view = await hold.fetchVault(opened.vault);
      assert.equal(view.pending.length, 0);
      assert.equal(await tokenAmount(connection, opened.vaultToken), beforeBig - BIG);
      assert.equal(await tokenAmount(connection, payeeAta), payeeBeforeBig + BIG);
      paidAfter = `paid ${BIG} to ${payeeAta.toBase58()} after the clock passed ${big.unlockAt}`;
    }

    const vaultBeforeStop = await tokenAmount(connection, opened.vaultToken);
    await hold.withdraw({
      owner,
      vaultId: VAULT_ID,
      destination: otherAta,
      mint,
      amount: STOP_AMOUNT,
    });
    view = await hold.fetchVault(opened.vault);
    const stopped = view.pending.find((row) => row.destination.equals(otherAta));
    assert.ok(stopped, "the withdrawal to the new address was not held");
    assert.equal(stopped.amount, STOP_AMOUNT);
    assert.equal(await tokenAmount(connection, otherAta), 0n);
    assert.equal(await tokenAmount(connection, opened.vaultToken), vaultBeforeStop);

    await hold.stop({
      authority: guardian,
      owner: owner.publicKey,
      vaultId: VAULT_ID,
      id: stopped.id,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.pending.some((row) => row.id === stopped.id), false);
    assert.equal(await tokenAmount(connection, otherAta), 0n);
    assert.equal(await tokenAmount(connection, opened.vaultToken), vaultBeforeStop);

    await hold.freeze({
      authority: guardian,
      owner: owner.publicKey,
      vaultId: VAULT_ID,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.frozen, true);

    const vaultBeforeRecover = await tokenAmount(connection, opened.vaultToken);
    assert.equal(vaultBeforeRecover > 0n, true);
    await hold.recover({
      authority: owner,
      owner: owner.publicKey,
      vaultId: VAULT_ID,
      destination: safeAta,
      mint,
    });
    const safeAccount = await getAccount(connection, safeAta, "confirmed");
    assert.equal(safeAccount.owner.equals(safe.publicKey), true);
    assert.equal(safeAccount.amount, vaultBeforeRecover);
    assert.equal(await tokenAmount(connection, opened.vaultToken), 0n);
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.frozen, true);

    await hold.unfreeze({
      owner,
      guardian,
      vaultId: VAULT_ID,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.frozen, false);

    const beforeLoosen = await chainNow(connection);
    await hold.proposeChange({
      owner,
      vaultId: VAULT_ID,
      dailyLimit: view.dailyLimit,
      delaySecs: view.delaySecs,
      bigShareBps: LOOSE_SHARE,
      guardian: view.guardian,
      safeAddress: view.safeAddress,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.bigShareBps, SHARE);
    assert.equal(view.change.active, true);
    assert.equal(view.change.bigShareBps, LOOSE_SHARE);
    assert.equal(view.change.fields, CHANGE_SHARE);
    assert.equal(view.change.effectiveAt >= beforeLoosen + DAY, true);
    const loosenAt = view.change.effectiveAt;
    await expectRefuse(
      "apply loosening before it is due",
      () =>
        hold.applyChange({
          payer: stranger,
          owner: owner.publicKey,
          vaultId: VAULT_ID,
        }),
      ["ChangeNotReady", "0x179d", "6045", "has not reached the change"],
    );
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.bigShareBps, SHARE);
    assert.equal(view.change.active, true);

    await hold.proposeChange({
      owner,
      vaultId: VAULT_ID,
      dailyLimit: TIGHT_DAILY,
      delaySecs: view.delaySecs,
      bigShareBps: view.bigShareBps,
      guardian: view.guardian,
      safeAddress: view.safeAddress,
    });
    view = await hold.fetchVault(opened.vault);
    assert.equal(view.dailyLimit, TIGHT_DAILY);
    assert.equal(view.bigShareBps, SHARE);
    assert.equal(view.delaySecs, DAY);
    assert.equal(view.change.active, true);

    const lines = [
      `cluster: ${CLUSTER} ${RPC}`,
      `vault: ${opened.vault.toBase58()}`,
      `mint: ${mint.toBase58()}`,
      "init: guardian and safe address set",
      `deposit: ${DEPOSIT}`,
      `everyday paid at once: ${EVERYDAY} to ${payeeAta.toBase58()}`,
      `big withdrawal held: ${BIG}, unlock ${big.unlockAt}`,
      "execute before unlock: refused, balances unchanged",
      `execute after unlock: ${paidAfter}`,
      `guardian stopped held withdrawal ${stopped.id}`,
      "freeze: guardian",
      `recover while frozen: ${vaultBeforeRecover} to safe ${safe.publicKey.toBase58()}`,
      "unfreeze: owner and guardian",
      `loosening share to ${LOOSE_SHARE} waits until ${loosenAt}`,
      `tightening daily limit applied at once: ${view.dailyLimit}`,
    ];
    console.log(lines.join("\n"));
  },
);
