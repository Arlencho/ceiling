#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, openSync, closeSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, release, arch, totalmem } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import anchor, { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAccount, createMint, mintTo, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config, percentile } from './config.js';

const { BN } = anchor;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const programId = new PublicKey('3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV');
const options = { commitment: 'confirmed' as const, preflightCommitment: 'confirmed' as const };
const cap = 1_000_000_000n;

async function assertFree(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function main() {
  const cfg = config(process.env, process.argv.includes('--smoke'));
  if (process.versions.node.split('.')[0] !== '22') throw new Error('Run with Node 22');
  for (const arg of process.argv.slice(2)) if (arg !== '--smoke') throw new Error(`Unknown argument: ${arg}`);
  process.env.PATH = `${process.env.HOME}/.cargo/bin:${process.env.HOME}/.avm/bin:${process.env.HOME}/.local/share/solana/install/active_release/bin:${process.env.PATH}`;
  const so = resolve(root, 'target/deploy/veto.so');
  if (!existsSync(so)) {
    const env = { ...process.env };
    delete env.ANCHOR_BUILD_SBF_ARCH;
    execFileSync('make', ['build'], { cwd: root, env, stdio: 'inherit' });
  }
  const metadata = {
    label: 'laptop lower bound',
    machine: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    validatorVersion: execFileSync('solana-test-validator', ['--version'], { encoding: 'utf8' }).trim(),
    node: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    soSha256: createHash('sha256').update(readFileSync(so)).digest('hex'),
    durationSeconds: cfg.duration, rules: cfg.n, agents: cfg.a, senders: cfg.w,
    rpc: cfg.rpc, recordedAt: new Date().toISOString(),
  };
  for (const port of [cfg.port, cfg.port + 1, cfg.port + 2]) await assertFree(port);
  const directory = mkdtempSync(join(tmpdir(), 'veto-validator-'));
  const log = join(directory, 'stdout.log');
  const fd = openSync(log, 'w');
  const child = spawn('solana-test-validator', ['--quiet', '--reset', '--ledger', join(directory, 'ledger'),
    '--bind-address', '127.0.0.1', '--rpc-port', String(cfg.port), '--faucet-port', String(cfg.port + 2),
    '--bpf-program', programId.toBase58(), so], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let childError: Error | undefined;
  child.on('error', error => { childError = error; });
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const connection = new Connection(cfg.rpc, { ...options, confirmTransactionInitialTimeout: 30_000,
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) }) });
  const check = () => {
    abort.signal.throwIfAborted();
    if (childError) throw childError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Validator exited');
  };
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      check();
      try { await connection.getLatestBlockhash(); ready = true; break; } catch { await sleep(500); }
    }
    if (!ready) throw new Error('Validator readiness timed out');
    const loaded = await connection.getAccountInfo(programId);
    if (!loaded?.executable) throw new Error('Program is not executable');
    const owner = Keypair.generate();
    const airdrop = await connection.requestAirdrop(owner.publicKey, 1000 * 1e9);
    const block = await connection.getLatestBlockhash();
    const funded = await connection.confirmTransaction({ ...block, signature: airdrop }, 'confirmed');
    if (funded.value.err) throw new Error('Airdrop failed');
    const program = new Program(JSON.parse(readFileSync(resolve(root, 'sdk/idl/veto.json'), 'utf8')) as Idl,
      new AnchorProvider(connection, new Wallet(owner), options));
    if (!program.programId.equals(programId)) throw new Error('IDL program mismatch');
    const agents = Array.from({ length: cfg.a }, () => Keypair.generate());
    const payers = Array.from({ length: cfg.w }, () => Keypair.generate());
    for (const payer of payers) await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: payer.publicKey, lamports: 1e9 })), [owner], options);
    const mint = await createMint(connection, owner, owner.publicKey, null, 6, undefined, options);
    const results = [];
    for (const shape of ['distinct', 'shared'] as const) {
      check();
      console.log(`Preparing ${cfg.n} ${shape} rules across ${cfg.a} agents`);
      const sharedMerchant = Keypair.generate().publicKey;
      const sharedDestination = shape === 'shared' ? await createAccount(connection, owner, mint, sharedMerchant, Keypair.generate(), options) : undefined;
      const rules: { agent: Keypair; mandate: PublicKey; ledger: PublicKey; source: PublicKey; destination: PublicKey; nonce: number; busy: boolean }[] = [];
      for (let i = 0; i < cfg.n; i++) {
        check();
        const agent = agents[i % agents.length];
        const merchant = shape === 'shared' ? sharedMerchant : Keypair.generate().publicKey;
        const destination = sharedDestination ?? await createAccount(connection, owner, mint, merchant, Keypair.generate(), options);
        const source = await createAccount(connection, owner, mint, owner.publicKey, Keypair.generate(), options);
        await mintTo(connection, owner, mint, source, owner, cap, [], options);
        const id = BigInt(i + (shape === 'shared' ? cfg.n : 0));
        const seed = Buffer.alloc(8); seed.writeBigUInt64LE(id);
        const mandate = PublicKey.findProgramAddressSync([Buffer.from('mandate'), owner.publicKey.toBuffer(), seed], programId)[0];
        const ledger = PublicKey.findProgramAddressSync([Buffer.from('ledger'), mandate.toBuffer()], programId)[0];
        await program.methods.openMandate({ mandateId: new BN(id.toString()), agent: agent.publicKey, merchant,
          cap: new BN(cap.toString()), perTxMax: new BN(1), expiresAt: new BN(Math.floor(Date.now() / 1000) + 86400), purpose: 'validator loadtest' })
          .accountsPartial({ owner: owner.publicKey, mandate, ledger, source, mint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
        rules.push({ agent, mandate, ledger, source, destination, nonce: 0, busy: false });
      }
      const latencies: number[] = [];
      const errors: Record<string, number> = {};
      let attempts = 0, failures = 0, confirmed = 0, withinWindow = 0, cursor = 0;
      const start = performance.now();
      const deadline = start + cfg.duration * 1000;
      console.log(`Running ${shape} for ${cfg.duration}s with ${cfg.w} senders`);
      await Promise.all(payers.map(async payer => {
        while (performance.now() < deadline) {
          check();
          let rule;
          for (let i = 0; i < rules.length; i++) {
            const candidate = rules[cursor++ % rules.length];
            if (!candidate.busy) { rule = candidate; rule.busy = true; break; }
          }
          if (!rule) { await sleep(1); continue; }
          let sentAt: number | undefined;
          try {
            const ix = await program.methods.charge(new BN(1), new BN(++rule.nonce)).accountsPartial({
              agent: rule.agent.publicKey, mandate: rule.mandate, ledger: rule.ledger, source: rule.source,
              destination: rule.destination, mint, tokenProgram: TOKEN_PROGRAM_ID }).instruction();
            const latest = await connection.getLatestBlockhash();
            const tx = new Transaction({ ...latest, feePayer: payer.publicKey }).add(ix);
            tx.sign(payer, rule.agent);
            if (performance.now() >= deadline) continue;
            sentAt = performance.now(); attempts++;
            const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
            // Polling avoids one websocket per sender and bounds every confirmation.
            for (;;) {
              check();
              const status = (await connection.getSignatureStatuses([signature])).value[0];
              if (status?.err) throw new Error(JSON.stringify(status.err));
              if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
              if (performance.now() - sentAt > 30_000) throw new Error('Confirmation timeout (outcome unknown)');
              await sleep(50);
            }
            const end = performance.now();
            confirmed++; if (end <= deadline) withinWindow++;
            latencies.push(end - sentAt);
          } catch (error) {
            if (sentAt === undefined) throw error;
            failures++;
            const message = String(error).slice(0, 300);
            errors[message] = (errors[message] ?? 0) + 1;
          } finally { rule.busy = false; }
        }
      }));
      const elapsedSeconds = (performance.now() - start) / 1000;
      let paid = 0n;
      for (const destination of new Map(rules.map(rule => [rule.destination.toBase58(), rule.destination])).values()) {
        paid += (await getAccount(connection, destination, 'confirmed')).amount;
      }
      results.push({ ...metadata, shape, attempts, confirmed, confirmedWithinWindow: withinWindow,
        confirmedTps: withinWindow / cfg.duration, elapsedIncludingDrainSeconds: elapsedSeconds,
        p50SendToConfirmedMs: percentile(latencies, 0.5), p99SendToConfirmedMs: percentile(latencies, 0.99),
        failures, errors, paidTokenUnits: paid.toString(), paymentsMatchConfirmed: paid === BigInt(confirmed) });
    }
    const reportDir = resolve(root, 'loadtest/reports');
    mkdirSync(reportDir, { recursive: true });
    // One compact JSON record per physical line inside a valid JSON array.
    writeFileSync(join(reportDir, 'validator.json'), `[${results.map(row => JSON.stringify(row)).join(',\n')}]\n`);
    writeFileSync(join(reportDir, 'validator.md'), results.map(row =>
      `- laptop lower bound | shape=${row.shape} | confirmed TPS=${row.confirmedTps.toFixed(2)} | p50 ms=${row.p50SendToConfirmedMs?.toFixed(2) ?? 'n/a'} | p99 ms=${row.p99SendToConfirmedMs?.toFixed(2) ?? 'n/a'} | failures=${row.failures} | confirmed=${row.confirmed} | attempts=${row.attempts} | paid=${row.paidTokenUnits} | payments match=${row.paymentsMatchConfirmed} | N=${row.rules} A=${row.agents} W=${row.senders} | duration=${row.durationSeconds}s | drain elapsed=${row.elapsedIncludingDrainSeconds.toFixed(3)}s | machine=${JSON.stringify(row.machine)} | validator=${row.validatorVersion} | node=${row.node} | commit=${row.commit} | dirty=${row.dirty} | .so sha256=${row.soSha256} | recorded=${row.recordedAt}`
    ).join('\n') + '\n');
    console.log(JSON.stringify(results, null, 2));
    if (results.some(row => !row.paymentsMatchConfirmed || row.confirmed === 0 || row.failures > 0)) {
      throw new Error('Benchmark recorded failures, zero confirmations, or payment mismatches; inspect reports');
    }
  } catch (error) {
    console.error(readFileSync(log, 'utf8').slice(-8000));
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(kill);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
