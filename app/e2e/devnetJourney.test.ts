// Devnet journey through the app's own chain calls and the agent SDK.
//
// Skipped unless VETO_E2E=1. `npm test` does not set that, so this file does
// not touch a cluster from the unit suite. `make e2e-devnet` does.
//
// Needs keys/deployer.json (gitignored). That key is the mint authority for
// the demo mint in docs/DEVNET.md. The payee is the merchant already on devnet.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import test from 'node:test';
import { Buffer } from 'buffer';
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountInfo,
} from '@solana/web3.js';

import {
  KIND_OPENED,
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  KIND_REVOKED,
  REASON_OVER_PER_TX_MAX,
  STATUS_ACTIVE,
  STATUS_REVOKED,
} from '../lib/constants';
import { decodeEventsFromLogs } from '../lib/events';
import type { MandateAccount } from '../lib/mandate';
import { openFundsRefusal, readTokenAmount } from '../lib/ruleAccount';
import { ledgerPda } from '../lib/ring';
import {
  persistSession,
  signAndSendTransactions,
  type MwaWallet,
  type SignAndSendParams,
  type TransactFn,
  type WalletStore,
} from '../lib/wallet';
import { VetoAgent } from '../../sdk/src/index.js';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

const ENABLED = process.env.VETO_E2E === '1';
const PROGRAM_ID_STR = '3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV';
const MINT_STR = '2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU';
const MERCHANT_STR = '6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG';
const MERCHANT_ATA_STR = '2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F';
const RPC =
  process.env.VETO_RPC?.trim() ||
  process.env.EXPO_PUBLIC_VETO_RPC?.trim() ||
  'https://api.devnet.solana.com';
const DECIMALS = 6;
const CAP_A = 1_000_000n;
const PER_A = 200_000n;
const CAP_B = 2_000_000n;
const PER_B = 500_000n;
const PAY_A = 100_000n;
const OVER_A = 300_000n;
const PAY_B = 150_000n;
const PAY_B_AFTER = 200_000n;
const MINT_TO = 5_000_000n;
const OWNER_LAMPORTS = 400_000_000;
const AGENT_LAMPORTS = 50_000_000;
const DEPLOYER_RESERVE = 100_000_000;
const REFUSED_EVENT_DISC = Buffer.from([230, 49, 133, 208, 106, 62, 106, 169]);

const REPO = fileUrlDir(new URL('../..', import.meta.url));
const TOOLS = join(REPO, 'tools');
const REPORT = fileUrlDir(new URL('./last-run.md', import.meta.url));
const DEPLOYER_PATH = join(REPO, 'keys', 'deployer.json');

process.env.VETO_RPC = RPC;
process.env.EXPO_PUBLIC_VETO_RPC = process.env.EXPO_PUBLIC_VETO_RPC?.trim() || RPC;
process.env.EXPO_PUBLIC_VETO_PROGRAM_ID = process.env.EXPO_PUBLIC_VETO_PROGRAM_ID?.trim() || PROGRAM_ID_STR;
process.env.EXPO_PUBLIC_VETO_MINT = process.env.EXPO_PUBLIC_VETO_MINT?.trim() || MINT_STR;
process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER =
  process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER?.trim() || 'devnet';
process.env.EXPO_PUBLIC_VETO_MINT_DECIMALS = process.env.EXPO_PUBLIC_VETO_MINT_DECIMALS?.trim() || '6';

type TokenView = {
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
};

type Books = {
  a: TokenView;
  b: TokenView;
  payee: TokenView;
  owner: TokenView;
};

type ChargeNote = {
  label: string;
  signature: string;
  kind: 'paid' | 'refused';
  amount: bigint;
  nonce: bigint;
  mandate: string;
};

type Row = {
  step: string;
  action: string;
  signature: string;
  result: 'pass' | 'fail';
  detail: string;
};

type ChainModule = typeof import('../lib/chain');

const requireFromSdk = createRequire(new URL('../../sdk/package.json', import.meta.url));
const { Keypair: SdkKeypair } = requireFromSdk('@solana/web3.js') as typeof import('@solana/web3.js');

function fileUrlDir(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function eventually(fn: () => Promise<void>, attempts = 12): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fn();
      return;
    } catch (err) {
      last = err;
      if (attempt < attempts - 1) await sleep(500);
    }
  }
  throw last instanceof Error ? last : new Error(errorText(last));
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const extra = err as Error & { logs?: string[]; transactionLogs?: string[] };
  const logs = extra.transactionLogs ?? extra.logs ?? [];
  return [err.message, ...logs].filter((part) => part.length > 0).join(' ');
}

function isTransient(err: unknown): boolean {
  const message = errorText(err);
  if (/simulation failed|custom program error|already been processed|Blockhash not found/i.test(message)) {
    return false;
  }
  return /429|Too Many Requests|rate limit|ECONNRESET|ETIMEDOUT|socket hang up|503|502|fetch failed|timed out/i.test(message);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransient(err) || attempt === 5) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(`${label} failed`);
}

function retryingConnection(inner: Connection): Connection {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const invoke = () => (value as (...a: unknown[]) => unknown).apply(target, args);
        try {
          const result = invoke();
          if (!result || typeof (result as Promise<unknown>).then !== 'function') return result;
          return (result as Promise<unknown>).catch((err: unknown) => {
            if (!isTransient(err)) throw err;
            return withRetry(String(prop), () => invoke() as Promise<unknown>);
          });
        } catch (err) {
          if (!isTransient(err)) throw err;
          return withRetry(String(prop), () => invoke() as Promise<unknown>);
        }
      };
    },
  }) as Connection;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function memoryStore(): WalletStore {
  const items = new Map<string, string>();
  return {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    deleteItem: async (key) => {
      items.delete(key);
    },
  };
}

function keypairWallet(owner: Keypair, connection: Connection): MwaWallet {
  return {
    async authorize() {
      return {
        accounts: [{ address: owner.publicKey.toBase58(), publicKey: owner.publicKey.toBytes() }],
        auth_token: 'devnet-journey',
      };
    },
    async deauthorize() {
      return undefined;
    },
    async signAndSendTransactions(params: SignAndSendParams) {
      const signatures: string[] = [];
      for (const tx of params.transactions) {
        tx.sign(owner);
        let signature: string;
        try {
          signature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: params.skipPreflight ?? false,
            preflightCommitment: 'confirmed',
            maxRetries: params.maxRetries,
            minContextSlot: params.minContextSlot,
          });
        } catch (err) {
          const message = errorText(err);
          if (!/already been processed/i.test(message)) throw err;
          const signed = tx.signature;
          if (!signed) throw err;
          signature = encodeBase58(signed);
        }
        signatures.push(signature);
      }
      return signatures;
    },
  };
}

function decodeToken(data: Uint8Array): TokenView {
  const raw = AccountLayout.decode(Buffer.from(data));
  const option = Number(raw.delegateOption);
  let delegate: string | null = null;
  if (option === 1) {
    const key = new PublicKey(raw.delegate).toBase58();
    if (key !== PublicKey.default.toBase58()) delegate = key;
  }
  return {
    amount: BigInt(raw.amount.toString()),
    delegate,
    delegatedAmount: BigInt(raw.delegatedAmount.toString()),
  };
}

function sameToken(actual: TokenView, expected: TokenView, label: string): void {
  assert.equal(actual.amount, expected.amount, `${label} balance`);
  assert.equal(actual.delegate, expected.delegate, `${label} delegate`);
  assert.equal(actual.delegatedAmount, expected.delegatedAmount, `${label} delegated amount`);
}

function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

function renderReport(args: {
  rows: Row[];
  started: string;
  owner: string;
  agent: string;
  ruleA: string;
  ruleB: string;
}): string {
  const lines = [
    '# Devnet journey',
    '',
    `Run started: ${args.started}`,
    `RPC: ${RPC}`,
    `Program: ${PROGRAM_ID_STR}`,
    `Mint: ${MINT_STR}`,
    `Owner: ${args.owner || 'not funded yet'}`,
    `Agent: ${args.agent || 'not funded yet'}`,
    `Merchant: ${MERCHANT_STR}`,
    `Rule A: ${args.ruleA || 'not opened yet'}`,
    `Rule B: ${args.ruleB || 'not opened yet'}`,
    '',
    '| Step | Action | Signature | Result | Detail |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of args.rows) {
    lines.push(
      `| ${cell(row.step)} | ${cell(row.action)} | ${cell(row.signature)} | ${row.result} | ${cell(row.detail)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function runTool(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', ...args], {
      cwd: TOOLS,
      env: { ...process.env, VETO_RPC: RPC },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  'devnet journey opens two rules, pays, refuses, overrides, revokes, closes, and verifies every decision',
  {
    skip: ENABLED ? false : 'set VETO_E2E=1 to run against devnet',
    timeout: 1_200_000,
  },
  async () => {
    if (/mainnet/i.test(RPC)) {
      throw new Error(`refusing to run the journey against ${RPC}`);
    }
    const started = new Date().toISOString();
    const rows: Row[] = [];
    const decisions: ChargeNote[] = [];
    const tempDir = mkdtempSync(join(tmpdir(), 'veto-e2e-'));
    const ids = { owner: '', agent: '', ruleA: '', ruleB: '' };

    const flush = () => {
      writeFileSync(REPORT, renderReport({ rows, started, ...ids }));
    };
    const record = (row: Row) => {
      rows.push(row);
      console.log(`${row.step}\t${row.action}\t${row.signature}\t${row.result}\t${row.detail}`);
      flush();
    };
    async function step<T extends { signature?: string; detail?: string }>(
      stepNo: string,
      action: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      try {
        const out = await fn();
        record({
          step: stepNo,
          action,
          signature: out.signature ?? '',
          result: 'pass',
          detail: out.detail ?? '',
        });
        await sleep(300);
        return out;
      } catch (err) {
        record({
          step: stepNo,
          action,
          signature: '',
          result: 'fail',
          detail: errorText(err),
        });
        throw err;
      }
    }

    try {
      const chain: ChainModule = await import('../lib/chain');
      const {
        closeMandate,
        createClient,
        fetchLedger,
        fetchLedgerRows,
        fetchMandate,
        grantOverride,
        openMandate,
        probeOverride,
        readRuleFunds,
        revokeMandate,
      } = chain;

      const raw = new Connection(RPC, 'confirmed');
      const connection = retryingConnection(raw);
      const client = createClient({
        rpcUrl: RPC,
        programId: PROGRAM_ID_STR,
        mint: MINT_STR,
        explorerCluster: 'devnet',
        mintDecimals: DECIMALS,
      });
      client.connection = connection;

      const programId = new PublicKey(PROGRAM_ID_STR);
      const mint = new PublicKey(MINT_STR);
      const merchant = new PublicKey(MERCHANT_STR);
      const merchantAta = getAssociatedTokenAddressSync(mint, merchant, true, TOKEN_PROGRAM_ID);
      assert.equal(
        merchantAta.toBase58(),
        MERCHANT_ATA_STR,
        'merchant associated token account does not match the devnet record',
      );

      const deployerFile = readFileSync(DEPLOYER_PATH, 'utf8');
      const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(deployerFile) as number[]));
      const owner = Keypair.generate();
      const agentSdk = SdkKeypair.generate();
      const agentForApp = new PublicKey(agentSdk.publicKey.toBytes());
      ids.owner = owner.publicKey.toBase58();
      ids.agent = agentSdk.publicKey.toBase58();
      flush();

      const store = memoryStore();
      await persistSession(store, {
        authToken: 'devnet-journey',
        ownerPublicKey: owner.publicKey.toBase58(),
      });
      const wallet = keypairWallet(owner, connection);
      const transact: TransactFn = (callback) => callback(wallet);
      const signAndSend = (transactions: Transaction[]) =>
        signAndSendTransactions(transact, store, transactions);

      const agentFor = (mandate: string) =>
        new VetoAgent({
          connection: connection as never,
          agent: agentSdk as never,
          mandate,
          programId: PROGRAM_ID_STR,
        });

      async function info(address: PublicKey): Promise<AccountInfo<Buffer> | null> {
        return connection.getAccountInfo(address, 'confirmed');
      }

      async function tokens(addresses: PublicKey[]): Promise<Array<TokenView | null>> {
        const found = await connection.getMultipleAccountsInfo(addresses, 'confirmed');
        return found.map((account) => (account ? decodeToken(account.data) : null));
      }

      async function requireToken(address: PublicKey, label: string): Promise<TokenView> {
        const [view] = await tokens([address]);
        assert.ok(view, `${label} token account ${address.toBase58()} is missing`);
        return view;
      }

      async function logsOf(signature: string): Promise<string[]> {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (tx?.meta?.logMessages) return tx.meta.logMessages;
          await sleep(500);
        }
        throw new Error(`transaction ${signature} has no logs`);
      }

      async function feeOf(signature: string): Promise<number> {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (tx?.meta && typeof tx.meta.fee === 'number') return tx.meta.fee;
          await sleep(500);
        }
        throw new Error(`fee for ${signature} was not readable`);
      }

      function suggestedOverrideFromLogs(logs: string[]): bigint | null {
        for (const line of logs) {
          const match = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line);
          if (!match?.[1]) continue;
          const raw = Buffer.from(match[1], 'base64');
          if (raw.length < 65 || !raw.subarray(0, 8).equals(REFUSED_EVENT_DISC)) continue;
          return raw.readBigUInt64LE(57);
        }
        return null;
      }

      function assertEvent(
        logs: string[],
        signature: string,
        kind: number,
        amount: bigint,
        nonce: bigint,
        reason?: number,
        suggested?: bigint,
      ): void {
        const events = decodeEventsFromLogs(signature, logs);
        const hit = events.find(
          (event) => event.kind === kind && event.amount === amount && event.nonce === nonce,
        );
        assert.ok(hit, `missing ${kind} event for amount ${amount.toString()} nonce ${nonce.toString()}`);
        if (reason !== undefined) assert.equal(hit.reason, reason);
        if (suggested !== undefined) {
          assert.equal(suggestedOverrideFromLogs(logs), suggested);
          assert.ok(
            logs.some((line) => line.includes(`override_to_clear=${suggested.toString()}`)),
            'program log does not record the override',
          );
        }
      }

      async function ringHas(
        mandate: PublicKey,
        kind: number,
        amount: bigint,
        nonce: bigint,
        reason?: number,
        suggested?: bigint,
      ): Promise<void> {
        const snapshot = await fetchLedger(client, mandate);
        const hit = snapshot.entries.find(
          (entry) => entry.kind === kind && entry.amount === amount && entry.nonce === nonce,
        );
        assert.ok(
          hit,
          `ledger ${snapshot.address} has no row kind ${kind} amount ${amount.toString()} nonce ${nonce.toString()}`,
        );
        if (reason !== undefined) assert.equal(hit.reason, reason);
        if (suggested !== undefined) assert.equal(hit.suggestedOverride, suggested);
      }

      const programInfo = await info(programId);
      assert.ok(programInfo, `program ${PROGRAM_ID_STR} is not on this cluster`);
      assert.equal(programInfo.executable, true);
      const mintInfo = await info(mint);
      assert.ok(mintInfo, `mint ${MINT_STR} is not on this cluster`);
      assert.equal(mintInfo.owner.toBase58(), TOKEN_PROGRAM_ID.toBase58());
      assert.equal(mintInfo.data[44], DECIMALS);
      const merchantInfo = await info(merchantAta);
      assert.ok(merchantInfo, `merchant token account ${MERCHANT_ATA_STR} is not on this cluster`);

      const deployerBalance = await connection.getBalance(deployer.publicKey, 'confirmed');
      const fundNeed = OWNER_LAMPORTS + AGENT_LAMPORTS + 20_000_000;
      assert.ok(
        deployerBalance >= fundNeed + DEPLOYER_RESERVE,
        `deployer holds ${deployerBalance} lamports, and funding needs ${fundNeed} plus a ${DEPLOYER_RESERVE} reserve`,
      );

      const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey, false, TOKEN_PROGRAM_ID);
      const fundSig = await step('setup', 'fund owner and agent from deployer', async () => {
        const latest = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction();
        tx.feePayer = deployer.publicKey;
        tx.recentBlockhash = latest.blockhash;
        tx.add(
          SystemProgram.transfer({
            fromPubkey: deployer.publicKey,
            toPubkey: owner.publicKey,
            lamports: OWNER_LAMPORTS,
          }),
          SystemProgram.transfer({
            fromPubkey: deployer.publicKey,
            toPubkey: agentForApp,
            lamports: AGENT_LAMPORTS,
          }),
          createAssociatedTokenAccountIdempotentInstruction(
            deployer.publicKey,
            ownerAta,
            owner.publicKey,
            mint,
            TOKEN_PROGRAM_ID,
          ),
          createMintToInstruction(mint, ownerAta, deployer.publicKey, MINT_TO, [], TOKEN_PROGRAM_ID),
        );
        tx.sign(deployer);
        const signature = await connection.sendRawTransaction(tx.serialize(), {
          preflightCommitment: 'confirmed',
        });
        await connection.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          'confirmed',
        );
        await eventually(async () => {
          const ownerSol = await connection.getBalance(owner.publicKey, 'confirmed');
          const agentSol = await connection.getBalance(agentForApp, 'confirmed');
          const funded = await requireToken(ownerAta, 'owner');
          assert.equal(ownerSol, OWNER_LAMPORTS);
          assert.equal(agentSol, AGENT_LAMPORTS);
          assert.equal(funded.amount, MINT_TO);
        });
        return { signature, detail: `owner ${ids.owner} agent ${ids.agent}` };
      });
      void fundSig;

      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);

      async function preflightOpen(cap: bigint): Promise<void> {
        const ataInfo = await info(ownerAta);
        assert.ok(ataInfo, 'owner associated token account disappeared before open');
        const balance = readTokenAmount(ataInfo.data);
        assert.ok(balance !== null, 'owner associated token account could not be read');
        const refusal = openFundsRefusal({
          ata: ownerAta,
          ataFound: true,
          balance,
          cap,
          decimals: DECIMALS,
        });
        assert.equal(refusal, null, refusal ?? undefined);
      }

      const openedA = await step('1', 'open rule A', async () => {
        await preflightOpen(CAP_A);
        const opened = await openMandate(client, signAndSend, {
          owner: owner.publicKey,
          agent: agentForApp,
          merchant,
          cap: CAP_A,
          perTxMax: PER_A,
          expiresAt,
          purpose: 'journey rule A',
          mint,
        });
        ids.ruleA = opened.mandate.address;
        flush();
        assert.equal(opened.mandate.agent, ids.agent);
        assert.equal(opened.mandate.mint, MINT_STR);
        assert.equal(opened.mandate.merchant, MERCHANT_STR);
        assert.equal(opened.mandate.cap, CAP_A);
        assert.equal(opened.mandate.perTxMax, PER_A);
        assert.equal(opened.mandate.status, STATUS_ACTIVE);
        assert.notEqual(opened.mandate.source, ownerAta.toBase58());
        const mandateInfo = await info(new PublicKey(opened.mandate.address));
        const ledgerInfo = await info(new PublicKey(opened.ledger));
        const sourceInfo = await info(new PublicKey(opened.mandate.source));
        assert.ok(mandateInfo, 'rule A mandate account is missing');
        assert.ok(ledgerInfo, 'rule A ledger account is missing');
        assert.ok(sourceInfo, 'rule A token account is missing');
        assert.equal(mandateInfo.owner.toBase58(), PROGRAM_ID_STR);
        assert.equal(sourceInfo.owner.toBase58(), TOKEN_PROGRAM_ID.toBase58());
        const source = decodeToken(sourceInfo.data);
        assert.equal(source.amount, CAP_A);
        assert.equal(source.delegate, opened.mandate.address);
        assert.equal(source.delegatedAmount, CAP_A);
        const funds = await readRuleFunds(client, opened.mandate);
        assert.equal(funds.kind, 'dedicated');
        assert.equal(funds.balance, CAP_A);
        assert.equal(funds.source, opened.mandate.source);
        await ringHas(new PublicKey(opened.mandate.address), KIND_OPENED, CAP_A, 0n);
        const logs = await logsOf(opened.signature);
        assert.ok(logs.some((line) => line.includes('VETO OPENED')));
        const ownerTokens = await requireToken(ownerAta, 'owner');
        assert.equal(ownerTokens.amount, MINT_TO - CAP_A);
        return {
          signature: opened.signature,
          detail: opened.mandate.address,
          mandate: opened.mandate,
          ledger: opened.ledger,
        };
      });

      const openedB = await step('1', 'open rule B', async () => {
        await preflightOpen(CAP_B);
        const opened = await openMandate(client, signAndSend, {
          owner: owner.publicKey,
          agent: agentForApp,
          merchant,
          cap: CAP_B,
          perTxMax: PER_B,
          expiresAt,
          purpose: 'journey rule B',
          mint,
        });
        ids.ruleB = opened.mandate.address;
        flush();
        assert.notEqual(opened.mandate.address, openedA.mandate.address);
        assert.notEqual(opened.mandate.source, openedA.mandate.source);
        assert.equal(opened.mandate.agent, ids.agent);
        assert.equal(opened.mandate.mint, MINT_STR);
        assert.equal(opened.mandate.cap, CAP_B);
        assert.equal(opened.mandate.perTxMax, PER_B);
        assert.notEqual(opened.mandate.perTxMax, openedA.mandate.perTxMax);
        assert.notEqual(opened.mandate.cap, openedA.mandate.cap);
        const sourceInfo = await info(new PublicKey(opened.mandate.source));
        assert.ok(sourceInfo, 'rule B token account is missing');
        const source = decodeToken(sourceInfo.data);
        assert.equal(source.amount, CAP_B);
        assert.equal(source.delegate, opened.mandate.address);
        assert.equal(source.delegatedAmount, CAP_B);
        const funds = await readRuleFunds(client, opened.mandate);
        assert.equal(funds.kind, 'dedicated');
        assert.equal(funds.balance, CAP_B);
        assert.equal(funds.source, opened.mandate.source);
        await ringHas(new PublicKey(opened.mandate.address), KIND_OPENED, CAP_B, 0n);
        const ownerTokens = await requireToken(ownerAta, 'owner');
        assert.equal(ownerTokens.amount, MINT_TO - CAP_A - CAP_B);
        return {
          signature: opened.signature,
          detail: opened.mandate.address,
          mandate: opened.mandate,
          ledger: opened.ledger,
        };
      });

      const sourceA = new PublicKey(openedA.mandate.source);
      const sourceB = new PublicKey(openedB.mandate.source);
      const mandateA = new PublicKey(openedA.mandate.address);
      const mandateB = new PublicKey(openedB.mandate.address);
      const isolatedB = await requireToken(sourceB, 'rule B');

      async function books(): Promise<Books> {
        const [a, b, payee, ownerTokens] = await tokens([sourceA, sourceB, merchantAta, ownerAta]);
        assert.ok(a && b && payee && ownerTokens, 'a token account in the journey disappeared');
        return { a, b, payee, owner: ownerTokens };
      }

      const vetoA = agentFor(openedA.mandate.address);
      const vetoB = agentFor(openedB.mandate.address);

      const paidA = await step('2', 'agent pays within rule A limit', async () => {
        const before = await books();
        const nonce = await vetoA.nextNonce();
        assert.equal(nonce, 1n);
        const outcome = await vetoA.charge({ amount: PAY_A, nonce });
        assert.equal(outcome.kind, 'paid');
        assert.equal(outcome.reasonCode, 0);
        const after = await books();
        assert.equal(after.a.amount, before.a.amount - PAY_A);
        assert.equal(after.a.delegate, openedA.mandate.address);
        assert.equal(after.a.delegatedAmount, before.a.delegatedAmount - PAY_A);
        assert.equal(after.payee.amount, before.payee.amount + PAY_A);
        sameToken(after.b, before.b, 'rule B during rule A payment');
        sameToken(after.owner, before.owner, 'owner associated account during rule A payment');
        const live = await fetchMandate(client, mandateA);
        assert.equal(live.spent, PAY_A);
        assert.equal(live.lastNonce, nonce);
        assert.equal(live.spendCount, 1);
        await ringHas(mandateA, KIND_PAID, PAY_A, nonce, 0, 0n);
        const logs = await logsOf(outcome.signature);
        assert.ok(logs.some((line) => line.includes('VETO PAID')));
        assertEvent(logs, outcome.signature, KIND_PAID, PAY_A, nonce, 0);
        decisions.push({
          label: 'rule A within limit',
          signature: outcome.signature,
          kind: 'paid',
          amount: PAY_A,
          nonce,
          mandate: openedA.mandate.address,
        });
        return { signature: outcome.signature, detail: `paid ${PAY_A.toString()} nonce ${nonce.toString()}` };
      });
      void paidA;

      let refusedNonce = 0n;
      let ruleAForGrant: MandateAccount = openedA.mandate;
      const refused = await step('3', 'agent asks above rule A per-payment limit', async () => {
        const before = await books();
        const nonce = await vetoA.nextNonce();
        refusedNonce = nonce;
        const outcome = await vetoA.charge({ amount: OVER_A, nonce });
        assert.equal(outcome.kind, 'refused');
        assert.equal(outcome.reasonCode, REASON_OVER_PER_TX_MAX);
        assert.equal(outcome.reasonText, 'over per-payment maximum');
        assert.equal(outcome.suggestedOverride, OVER_A);
        const after = await books();
        sameToken(after.a, before.a, 'rule A on refusal');
        sameToken(after.b, before.b, 'rule B on rule A refusal');
        sameToken(after.payee, before.payee, 'payee on refusal');
        sameToken(after.owner, before.owner, 'owner on refusal');
        const live = await fetchMandate(client, mandateA);
        assert.equal(live.spent, PAY_A);
        assert.equal(live.lastNonce, 1n);
        assert.equal(live.refusalCount, 1);
        assert.equal(live.overrideAmount, 0n);
        ruleAForGrant = live;
        await ringHas(mandateA, KIND_REFUSED, OVER_A, nonce, REASON_OVER_PER_TX_MAX, OVER_A);
        const logs = await logsOf(outcome.signature);
        assert.ok(logs.some((line) => line.includes('VETO REFUSED') && line.includes('reason=5')));
        assertEvent(logs, outcome.signature, KIND_REFUSED, OVER_A, nonce, REASON_OVER_PER_TX_MAX, OVER_A);
        decisions.push({
          label: 'rule A over per-payment limit',
          signature: outcome.signature,
          kind: 'refused',
          amount: OVER_A,
          nonce,
          mandate: openedA.mandate.address,
        });
        return {
          signature: outcome.signature,
          detail: `refused ${OVER_A.toString()} nonce ${nonce.toString()} override ${OVER_A.toString()}`,
        };
      });
      void refused;

      const granted = await step('4', 'owner grants the recorded override', async () => {
        const listed = await fetchLedgerRows(client, mandateA);
        const row = listed.rows.find(
          (entry) => entry.kind === KIND_REFUSED && entry.nonce === refusedNonce && entry.amount === OVER_A,
        );
        assert.ok(row, 'refused row is not on the ledger the app reads');
        assert.equal(row.reason, REASON_OVER_PER_TX_MAX);
        assert.equal(row.suggestedOverride, OVER_A);
        const probe = await probeOverride(client, mandateA, row, DECIMALS);
        if (probe.status !== 'ready') {
          throw new Error(probe.why);
        }
        assert.equal(probe.amount, OVER_A);
        assert.equal(probe.nonce, refusedNonce);
        const before = await books();
        const result = await grantOverride(client, signAndSend, owner.publicKey, ruleAForGrant, row, DECIMALS);
        const live = await fetchMandate(client, mandateA);
        assert.equal(live.overrideAmount, OVER_A);
        assert.equal(live.overrideNonce, refusedNonce);
        assert.equal(live.lastNonce, 1n);
        const after = await books();
        sameToken(after.a, before.a, 'rule A on override grant');
        sameToken(after.b, before.b, 'rule B on override grant');
        sameToken(after.payee, before.payee, 'payee on override grant');
        await ringHas(mandateA, KIND_OVERRIDE, OVER_A, refusedNonce);
        const logs = await logsOf(result.signature);
        assert.ok(logs.some((line) => line.includes('VETO OVERRIDE')));
        ruleAForGrant = live;
        return { signature: result.signature, detail: `override ${OVER_A.toString()} nonce ${refusedNonce.toString()}` };
      });
      void granted;

      const retried = await step('4', 'agent retries the overridden charge', async () => {
        const again = await vetoA.nextNonce();
        assert.equal(again, refusedNonce);
        const before = await books();
        const outcome = await vetoA.charge({ amount: OVER_A, nonce: refusedNonce });
        assert.equal(outcome.kind, 'paid');
        const after = await books();
        assert.equal(after.a.amount, before.a.amount - OVER_A);
        assert.equal(after.a.delegate, openedA.mandate.address);
        assert.equal(after.payee.amount, before.payee.amount + OVER_A);
        sameToken(after.b, isolatedB, 'rule B after every rule A charge');
        sameToken(after.owner, before.owner, 'owner associated account on retry');
        const live = await fetchMandate(client, mandateA);
        assert.equal(live.spent, PAY_A + OVER_A);
        assert.equal(live.lastNonce, refusedNonce);
        assert.equal(live.overrideAmount, 0n);
        assert.equal(live.overrideNonce, 0n);
        assert.equal(live.spendCount, 2);
        await ringHas(mandateA, KIND_PAID, OVER_A, refusedNonce, 0, 0n);
        const logs = await logsOf(outcome.signature);
        assert.ok(logs.some((line) => line.includes('VETO PAID')));
        assertEvent(logs, outcome.signature, KIND_PAID, OVER_A, refusedNonce, 0);
        decisions.push({
          label: 'rule A retry after override',
          signature: outcome.signature,
          kind: 'paid',
          amount: OVER_A,
          nonce: refusedNonce,
          mandate: openedA.mandate.address,
        });
        return { signature: outcome.signature, detail: `paid ${OVER_A.toString()} nonce ${refusedNonce.toString()}` };
      });
      void retried;

      const paidB = await step('5', 'agent pays under rule B', async () => {
        const before = await books();
        sameToken(before.b, isolatedB, 'rule B before its own payment');
        const nonce = await vetoB.nextNonce();
        assert.equal(nonce, 1n);
        const outcome = await vetoB.charge({ amount: PAY_B, nonce });
        assert.equal(outcome.kind, 'paid');
        const after = await books();
        assert.equal(after.b.amount, before.b.amount - PAY_B);
        assert.equal(after.b.delegate, openedB.mandate.address);
        assert.equal(after.b.delegatedAmount, before.b.delegatedAmount - PAY_B);
        assert.equal(after.payee.amount, before.payee.amount + PAY_B);
        sameToken(after.a, before.a, 'rule A during rule B payment');
        sameToken(after.owner, before.owner, 'owner associated account during rule B payment');
        const live = await fetchMandate(client, mandateB);
        assert.equal(live.spent, PAY_B);
        assert.equal(live.status, STATUS_ACTIVE);
        await ringHas(mandateB, KIND_PAID, PAY_B, nonce, 0, 0n);
        const logs = await logsOf(outcome.signature);
        assertEvent(logs, outcome.signature, KIND_PAID, PAY_B, nonce, 0);
        decisions.push({
          label: 'rule B within limit',
          signature: outcome.signature,
          kind: 'paid',
          amount: PAY_B,
          nonce,
          mandate: openedB.mandate.address,
        });
        return { signature: outcome.signature, detail: `paid ${PAY_B.toString()} nonce ${nonce.toString()}` };
      });
      void paidB;

      const revoked = await step('6', 'revoke rule A', async () => {
        const before = await books();
        const live = await fetchMandate(client, mandateA);
        const result = await revokeMandate(client, signAndSend, owner.publicKey, live);
        assert.equal(result.mandate.status, STATUS_REVOKED);
        const source = await requireToken(sourceA, 'rule A');
        assert.equal(source.delegate, null);
        assert.equal(source.delegatedAmount, 0n);
        assert.equal(source.amount, before.a.amount);
        const bNow = await requireToken(sourceB, 'rule B');
        assert.equal(bNow.delegate, openedB.mandate.address);
        assert.equal(bNow.amount, before.b.amount);
        await ringHas(mandateA, KIND_REVOKED, 0n, 0n);
        const logs = await logsOf(result.signature);
        assert.ok(logs.some((line) => line.includes('VETO REVOKED')));
        const still = await info(mandateA);
        assert.ok(still, 'revoked rule A mandate account is already gone');
        return { signature: result.signature, detail: 'rule A revoked, delegate cleared' };
      });
      void revoked;

      const paidBAgain = await step('6', 'agent pays under rule B after rule A is revoked', async () => {
        const before = await books();
        const nonce = await vetoB.nextNonce();
        const outcome = await vetoB.charge({ amount: PAY_B_AFTER, nonce });
        assert.equal(outcome.kind, 'paid');
        const after = await books();
        assert.equal(after.b.amount, before.b.amount - PAY_B_AFTER);
        assert.equal(after.b.delegate, openedB.mandate.address);
        assert.equal(after.payee.amount, before.payee.amount + PAY_B_AFTER);
        sameToken(after.a, before.a, 'revoked rule A during rule B payment');
        const liveB = await fetchMandate(client, mandateB);
        assert.equal(liveB.status, STATUS_ACTIVE);
        assert.equal(liveB.spent, PAY_B + PAY_B_AFTER);
        const liveA = await fetchMandate(client, mandateA);
        assert.equal(liveA.status, STATUS_REVOKED);
        await ringHas(mandateB, KIND_PAID, PAY_B_AFTER, nonce, 0, 0n);
        const logs = await logsOf(outcome.signature);
        assertEvent(logs, outcome.signature, KIND_PAID, PAY_B_AFTER, nonce, 0);
        decisions.push({
          label: 'rule B after rule A revoked',
          signature: outcome.signature,
          kind: 'paid',
          amount: PAY_B_AFTER,
          nonce,
          mandate: openedB.mandate.address,
        });
        return { signature: outcome.signature, detail: `paid ${PAY_B_AFTER.toString()} nonce ${nonce.toString()}` };
      });
      void paidBAgain;

      const remainingA = CAP_A - PAY_A - OVER_A;
      await step('7', 'close rule A', async () => {
        const live = await fetchMandate(client, mandateA);
        const funds = await readRuleFunds(client, live);
        assert.equal(funds.balance, remainingA);
        assert.equal(funds.closeCreatesAssociated, false);
        const ownerBeforeTokens = await requireToken(ownerAta, 'owner');
        const bBefore = await requireToken(sourceB, 'rule B');
        const mandateLamports = (await info(mandateA))?.lamports ?? 0;
        const ledgerLamports = (await info(new PublicKey(openedA.ledger)))?.lamports ?? 0;
        const tokenLamports = (await info(sourceA))?.lamports ?? 0;
        assert.ok(mandateLamports > 0 && ledgerLamports > 0 && tokenLamports > 0, 'rule A rent is already gone');
        const ownerBeforeSol = await connection.getBalance(owner.publicKey, 'confirmed');
        const result = await closeMandate(client, signAndSend, owner.publicKey, live);
        const fee = await feeOf(result.signature);
        const ownerAfterSol = await connection.getBalance(owner.publicKey, 'confirmed');
        const rent = mandateLamports + ledgerLamports + tokenLamports;
        assert.equal(ownerAfterSol, ownerBeforeSol + rent - fee, 'rule A rent did not all return');
        assert.equal(await info(mandateA), null);
        assert.equal(await info(new PublicKey(openedA.ledger)), null);
        assert.equal(await info(sourceA), null);
        assert.equal(ledgerPda(programId, mandateA).toBase58(), openedA.ledger);
        const ownerAfterTokens = await requireToken(ownerAta, 'owner');
        assert.equal(ownerAfterTokens.amount, ownerBeforeTokens.amount + remainingA);
        const bAfter = await requireToken(sourceB, 'rule B');
        sameToken(bAfter, bBefore, 'rule B during close of rule A');
        const logs = await logsOf(result.signature);
        assert.ok(logs.some((line) => line.includes('VETO CLOSED')));
        return {
          signature: result.signature,
          detail: `returned ${remainingA.toString()} tokens and ${rent.toString()} lamports, fee ${fee}`,
        };
      });

      const exported: string[] = [];
      await step('8', 'export and verify every decision', async () => {
        assert.ok(decisions.length >= 5, `expected 5 charge decisions, saw ${decisions.length}`);
        for (const decision of decisions) {
          const out = join(tempDir, `${decision.signature}.json`);
          const exportedRun = await runTool([
            'export.ts',
            '--signature',
            decision.signature,
            '--rpc',
            RPC,
            '--out',
            out,
          ]);
          if (exportedRun.code !== 0) {
            throw new Error(
              `export ${decision.label} failed: ${exportedRun.stderr || exportedRun.stdout}`.trim(),
            );
          }
          const recordJson = JSON.parse(readFileSync(out, 'utf8')) as {
            kind?: string;
            amount?: number;
            reason_code?: number;
            signature?: string;
            mandate?: string;
            suggested_override?: number;
          };
          assert.equal(recordJson.signature, decision.signature);
          assert.equal(recordJson.kind, decision.kind);
          assert.equal(recordJson.amount, Number(decision.amount));
          assert.equal(recordJson.mandate, decision.mandate);
          if (decision.kind === 'refused') {
            assert.equal(recordJson.reason_code, REASON_OVER_PER_TX_MAX);
            assert.equal(recordJson.suggested_override, Number(OVER_A));
          }
          const verified = await runTool(['verify.ts', out, '--rpc', RPC]);
          if (verified.code !== 0 || !verified.stdout.includes('VERDICT: CONFIRMED')) {
            throw new Error(
              `verify ${decision.label} failed (${verified.code}): ${verified.stdout}\n${verified.stderr}`.trim(),
            );
          }
          exported.push(out);
          record({
            step: '8',
            action: `verify ${decision.label}`,
            signature: decision.signature,
            result: 'pass',
            detail: 'VERDICT: CONFIRMED',
          });
        }
        return { signature: '', detail: `${exported.length} records CONFIRMED` };
      });

      await step('8', 'tamper one amount and verify again', async () => {
        assert.ok(exported[0], 'no exported record to tamper');
        const sourcePath = exported[0];
        const tamperedPath = join(tempDir, 'tampered.json');
        const body = JSON.parse(readFileSync(sourcePath, 'utf8')) as { amount?: number };
        body.amount = 1;
        writeFileSync(tamperedPath, `${JSON.stringify(body, null, 2)}\n`);
        const verified = await runTool(['verify.ts', tamperedPath, '--rpc', RPC]);
        if (verified.code !== 1 || !verified.stdout.includes('VERDICT: REJECTED')) {
          throw new Error(
            `tampered record was not rejected (${verified.code}): ${verified.stdout}\n${verified.stderr}`.trim(),
          );
        }
        assert.match(verified.stdout, /amount/);
        return { signature: decisions[0]?.signature ?? '', detail: 'VERDICT: REJECTED' };
      });

      const remainingB = CAP_B - PAY_B - PAY_B_AFTER;
      await step('9', 'close rule B', async () => {
        const live = await fetchMandate(client, mandateB);
        const funds = await readRuleFunds(client, live);
        assert.equal(funds.balance, remainingB);
        assert.equal(funds.closeCreatesAssociated, false);
        const ownerBeforeTokens = await requireToken(ownerAta, 'owner');
        const mandateLamports = (await info(mandateB))?.lamports ?? 0;
        const ledgerKey = new PublicKey(openedB.ledger);
        const ledgerLamports = (await info(ledgerKey))?.lamports ?? 0;
        const tokenLamports = (await info(sourceB))?.lamports ?? 0;
        const ownerBeforeSol = await connection.getBalance(owner.publicKey, 'confirmed');
        const result = await closeMandate(client, signAndSend, owner.publicKey, live);
        const fee = await feeOf(result.signature);
        const ownerAfterSol = await connection.getBalance(owner.publicKey, 'confirmed');
        const rent = mandateLamports + ledgerLamports + tokenLamports;
        assert.equal(ownerAfterSol, ownerBeforeSol + rent - fee, 'rule B rent did not all return');
        assert.equal(await info(mandateB), null);
        assert.equal(await info(ledgerKey), null);
        assert.equal(await info(sourceB), null);
        const ownerAfterTokens = await requireToken(ownerAta, 'owner');
        assert.equal(ownerAfterTokens.amount, ownerBeforeTokens.amount + remainingB);
        assert.equal(ownerAfterTokens.amount, MINT_TO - PAY_A - OVER_A - PAY_B - PAY_B_AFTER);
        const logs = await logsOf(result.signature);
        assert.ok(logs.some((line) => line.includes('VETO CLOSED')));
        return {
          signature: result.signature,
          detail: `returned ${remainingB.toString()} tokens and ${rent.toString()} lamports, fee ${fee}`,
        };
      });
    } finally {
      flush();
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
