#!/usr/bin/env node
import { dueSlots, msUntil, nextSlot } from "./cadence.js";
import { loadKeypair, mandatePda, openMandate, readLastNonce, recoverSettledCharge, submitCharge } from "./chain.js";
import { keyPath, loadConfig } from "./config.js";
import { EnergySpotFeed } from "./feed.js";
import { JsonlJournal } from "./journal.js";
import { logError, logLine } from "./log.js";
import { nonceFromWindowStart } from "./nonce.js";
import { processWindow, sleep, type ProcessResult } from "./run.js";
import { PublicKey } from "@solana/web3.js";

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function command(): string {
  const first = process.argv[2];
  if (first === undefined || first.startsWith("--")) return "run";
  return first;
}

async function withJournalAndFeed() {
  const cfg = loadConfig();
  const journal = new JsonlJournal(cfg.journalPath);
  const feed = new EnergySpotFeed();
  const agent = loadKeypair(keyPath(cfg, "agent"));
  const submit = (amount: bigint, nonce: bigint) => submitCharge({ cfg, agent, amount, nonce });
  const chainLastNonce = () => readLastNonce({ cfg, agent });
  const recoverSettled = (nonce: bigint) => recoverSettledCharge({ cfg, agent, nonce });
  return { cfg, journal, feed, submit, agent, chainLastNonce, recoverSettled };
}

async function processAt(at: Date): Promise<ProcessResult> {
  const { cfg, journal, feed, submit, chainLastNonce, recoverSettled } = await withJournalAndFeed();
  return processWindow({
    at,
    feed,
    journal,
    submit,
    kwhMilli: cfg.kwhMilli,
    mintDecimals: cfg.mintDecimals,
    chainLastNonce,
    recoverSettled,
  });
}

async function processDue(now: Date, announceIdle = false): Promise<boolean> {
  const { cfg, journal, feed, submit, chainLastNonce, recoverSettled } = await withJournalAndFeed();
  let acted = false;
  let deferred = false;
  for (const slot of dueSlots(now)) {
    const nonce = nonceFromWindowStart(slot.toISOString());
    if (journal.hasNonce(nonce)) continue;
    acted = true;
    const result = await processWindow({
      at: slot,
      feed,
      journal,
      submit,
      kwhMilli: cfg.kwhMilli,
      mintDecimals: cfg.mintDecimals,
      chainLastNonce,
      recoverSettled,
    });
    if (result === "deferred") deferred = true;
  }
  if (!acted && announceIdle) {
    logLine("caught up: no due cadence slots left to submit");
  }
  return deferred;
}

async function cmdOnce(): Promise<void> {
  const windowFlag = flag("window");
  if (windowFlag !== undefined) {
    const at = new Date(windowFlag);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`bad --window: ${windowFlag}`);
    }
    if (at.getTime() > Date.now()) {
      throw new Error("refusing a future window: wait for it, do not invent a present");
    }
    const result = await processAt(at);
    if (result === "deferred") {
      logError("once: rpc rate limited on all endpoints");
      process.exitCode = 1;
    }
    return;
  }
  const deferred = await processDue(new Date(), true);
  if (deferred) {
    logError("once: rpc rate limited on all endpoints");
    process.exitCode = 1;
  }
}

async function cmdRun(): Promise<void> {
  const cfg = loadConfig();
  logLine(
    `watcher start rpc=${cfg.rpcs.join(",")} mandate_id=${cfg.mandateId.toString()} kwh_milli=${cfg.kwhMilli.toString()} journal=${cfg.journalPath}`,
  );
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    logLine("watcher stopping after the current slot");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const now = new Date();
    await processDue(now);
    if (stopping) break;
    const wait = msUntil(nextSlot(now), new Date());
    const chunk = wait < 30_000 ? wait : 30_000;
    logLine(`idle next=${nextSlot(now).toISOString()} sleep_ms=${chunk}`);
    await sleep(chunk === 0 ? 1_000 : chunk);
  }
}

async function cmdOpenMandate(): Promise<void> {
  const cfg = loadConfig();
  const owner = loadKeypair(keyPath(cfg, "owner"));
  const nowUnix = BigInt(Date.now()) / 1000n;
  const expiresAtUnix = nowUnix + 90n * 24n * 60n * 60n;
  const result = await openMandate({ cfg, owner, expiresAtUnix });
  const programId = new PublicKey(cfg.programId);
  const mandate = mandatePda(programId, owner.publicKey, cfg.mandateId);
  if (result.signature.length === 0) {
    logLine(`mandate already open ${mandate.toBase58()}`);
    return;
  }
  logLine(`mandate opened ${result.mandate} ledger=${result.ledger} sig=${result.signature}`);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const journal = new JsonlJournal(cfg.journalPath);
  const counts = journal.counts();
  const rows = journal.load();
  const last = rows[rows.length - 1];
  logLine(
    `journal ${cfg.journalPath} total=${counts.total} paid=${counts.paid} refused=${counts.refused} gap=${counts.gap} skipped=${counts.skipped}`,
  );
  if (last !== undefined) {
    logLine(`last decision=${last.decision} reason=${last.reason} nonce=${last.nonce} sig=${last.signature ?? "-"}`);
  }
}

async function main(): Promise<void> {
  const cmd = command();
  if (hasFlag("help") || cmd === "help") {
    process.stdout.write(
      "veto-watcher <run|once|open-mandate|status> [--window ISO]\n",
    );
    return;
  }
  if (cmd === "once") {
    await cmdOnce();
    return;
  }
  if (cmd === "open-mandate") {
    await cmdOpenMandate();
    return;
  }
  if (cmd === "status") {
    await cmdStatus();
    return;
  }
  if (cmd === "run") {
    await cmdRun();
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logError(message);
  process.exitCode = 1;
});
