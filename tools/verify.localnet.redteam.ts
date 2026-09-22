// Security fixture for tools/verify.ts (issue #110, area 1), state-dependent cases.
//
// Needs a local validator with the program loaded twice: once at the committed
// id and once at a second id whose binary has declare_id patched to that id
// (a clone anyone can deploy). Creates its own mint, mandates and charges, then
// runs export.ts and verify.ts as the README tells a stranger to.
//
//   solana-test-validator --reset --rpc-port 18899 \
//     --bpf-program 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV target/deploy/veto.so \
//     --bpf-program <CLONE_ID> /tmp/veto-clone.so
//   VETO_RPC=http://127.0.0.1:18899 CLONE_PROGRAM_ID=<CLONE_ID> npx tsx verify.localnet.redteam.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anchorPkg, { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID as SPL,
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { IDL_PATH, TOOLS_DIR, ledgerPda, mandatePda } from "./lib.js";

const { BN } = anchorPkg;
const REAL = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cli(script: string, args: string[], env: Record<string, string>): { code: number; out: string } {
  const r = spawnSync("npx", ["tsx", join(TOOLS_DIR, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function verdict(out: string): string {
  return out.split("\n").find((l) => l.startsWith("VERDICT") || l.startsWith("verify failed")) ?? "(no verdict line)";
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "HOLDS" : "FAIL "}  ${name}  ->  ${detail}`);
}

// A local validator occasionally lets a blockhash lapse between sign and
// land. Resend once with a fresh blockhash rather than abort the fixture.
async function send(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fresh = new Transaction().add(...tx.instructions);
      return await sendAndConfirmTransaction(conn, fresh, signers, { commitment: "confirmed" });
    } catch (err) {
      lastErr = err;
      if (!(err instanceof Error) || !/expired|block height/i.test(err.message)) throw err;
    }
  }
  throw lastErr;
}

async function airdrop(conn: Connection, pk: PublicKey, sol: number): Promise<void> {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

type Fixture = {
  conn: Connection;
  program: Program;
  programId: PublicKey;
  owner: Keypair;
  agent: Keypair;
  mint: PublicKey;
  source: PublicKey;
  merchant: Keypair;
  merchantToken: PublicKey;
  mandate: PublicKey;
  ledger: PublicKey;
};

async function setup(conn: Connection, programId: PublicKey, perTxMax: bigint): Promise<Fixture> {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const merchant = Keypair.generate();
  await airdrop(conn, owner.publicKey, 5);
  await airdrop(conn, agent.publicKey, 2);
  const mint = await createMint(conn, owner, owner.publicKey, null, 6);
  const source = await createAssociatedTokenAccountIdempotent(conn, owner, mint, owner.publicKey);
  const merchantToken = await createAssociatedTokenAccountIdempotent(conn, owner, mint, merchant.publicKey);
  await mintTo(conn, owner, mint, source, owner, 1_000_000_000n);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as Idl & { address: string };
  idl.address = programId.toBase58();
  const provider = new AnchorProvider(conn, new Wallet(owner), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const mandateId = BigInt(Date.now());
  const mandate = mandatePda(programId, owner.publicKey, mandateId);
  const ledger = ledgerPda(programId, mandate);
  const now = Math.floor(Date.now() / 1000);
  const ix = await program.methods
    .openMandate({
      mandateId: new BN(mandateId.toString()),
      agent: agent.publicKey,
      merchant: merchant.publicKey,
      cap: new BN("1000000000"),
      perTxMax: new BN(perTxMax.toString()),
      expiresAt: new BN(String(now + 86400)),
      purpose: "audit 110",
    })
    .accountsPartial({
      owner: owner.publicKey,
      mandate,
      ledger,
      source,
      mint,
      tokenProgram: SPL,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await send(conn, new Transaction().add(ix), [owner]);
  return { conn, program, programId, owner, agent, mint, source, merchant, merchantToken, mandate, ledger };
}

async function chargeIx(f: Fixture, amount: bigint, nonce: bigint) {
  return f.program.methods
    .charge(new BN(amount.toString()), new BN(nonce.toString()))
    .accountsPartial({
      agent: f.agent.publicKey,
      mandate: f.mandate,
      ledger: f.ledger,
      source: f.source,
      destination: f.merchantToken,
      mint: f.mint,
      tokenProgram: SPL,
    })
    .instruction();
}

async function charge(f: Fixture, amount: bigint, nonce: bigint): Promise<string> {
  const ix = await chargeIx(f, amount, nonce);
  return send(f.conn, new Transaction().add(ix), [f.agent]);
}

async function main(): Promise<void> {
  const rpc = process.env.VETO_RPC;
  const cloneId = process.env.CLONE_PROGRAM_ID;
  if (!rpc || !cloneId) throw new Error("set VETO_RPC and CLONE_PROGRAM_ID");
  if (!/127\.0\.0\.1|localhost/.test(rpc)) throw new Error("this fixture creates state; local validator only");
  const CLONE = new PublicKey(cloneId);
  const conn = new Connection(rpc, "confirmed");
  const dir = mkdtempSync(join(tmpdir(), "veto-localnet-redteam-"));
  const envReal = { VETO_RPC: rpc, VETO_PROGRAM_ID: REAL.toBase58(), VETO_CLUSTER: "localnet" };
  const envClone = { VETO_RPC: rpc, VETO_PROGRAM_ID: CLONE.toBase58(), VETO_CLUSTER: "localnet" };
  const envVerify = { VETO_RPC: rpc };
  const exportTo = (sig: string, env: Record<string, string>, name: string): string => {
    const path = join(dir, `${name}.json`);
    const r = cli("export.ts", ["--signature", sig, "--out", path], env);
    if (r.code !== 0) throw new Error(`export failed for ${name}: ${r.out}`);
    return path;
  };
  const verifyPath = (path: string): { code: number; out: string } => cli("verify.ts", [path], envVerify);
  const mutate = (path: string, name: string, f: (r: Record<string, unknown>) => void): string => {
    const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    f(r);
    const out = join(dir, `${name}.json`);
    writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
    return out;
  };

  // --- A. Two refused charges with the same nonce, seconds apart.
  const f = await setup(conn, REAL, 500_000n);
  const sig1 = await charge(f, 600_000n, 5n);
  sleep(2500);
  const sig2 = await charge(f, 600_000n, 5n);
  const rec1 = exportTo(sig1, envReal, "refused-1");
  const rec2 = exportTo(sig2, envReal, "refused-2");
  const j1 = JSON.parse(readFileSync(rec1, "utf8")) as { timestamp: number; signature: string };
  const j2 = JSON.parse(readFileSync(rec2, "utf8")) as { timestamp: number; signature: string };
  console.log(`refused-1 ts=${j1.timestamp} sig=${j1.signature.slice(0, 8)}  refused-2 ts=${j2.timestamp} sig=${j2.signature.slice(0, 8)}`);
  check("export binds record 1 to its own transaction's time", j1.timestamp !== j2.timestamp, `ts ${j1.timestamp} vs ${j2.timestamp}`);
  const v1 = verifyPath(rec1);
  check("genuine record of the FIRST refusal confirms", v1.code === 0, verdict(v1.out) + " " + v1.out.split("\n").filter((l) => l.startsWith("- ")).join(" | "));
  const v2 = verifyPath(rec2);
  check("genuine record of the SECOND refusal confirms", v2.code === 0, verdict(v2.out));
  const forged = mutate(rec1, "refused-1-ts-of-2", (r) => { r.timestamp = j2.timestamp; });
  const vf = verifyPath(forged);
  check("record 1 with record 2's timestamp is rejected", vf.code !== 0, verdict(vf.out));

  // --- B. Paid charge, then revoke, then close.
  const sigPaid = await charge(f, 100_000n, 6n);
  const recPaid = exportTo(sigPaid, envReal, "paid");
  const vp = verifyPath(recPaid);
  check("control: genuine paid record confirms", vp.code === 0, verdict(vp.out));
  const revokeIx = await f.program.methods
    .revokeMandate()
    .accountsPartial({ owner: f.owner.publicKey, mandate: f.mandate, ledger: f.ledger, source: f.source, tokenProgram: SPL })
    .instruction();
  await send(conn, new Transaction().add(revokeIx), [f.owner]);
  const vr = verifyPath(recPaid);
  check("after revoke, the earlier paid record still confirms", vr.code === 0, verdict(vr.out));
  const closeIx = await f.program.methods
    .closeMandate()
    .accountsPartial({ owner: f.owner.publicKey, mandate: f.mandate, ledger: f.ledger })
    .instruction();
  await send(conn, new Transaction().add(closeIx), [f.owner]);
  const vc = verifyPath(recPaid);
  check("after close, the genuine paid record can still be confirmed", vc.code === 0, verdict(vc.out));

  // --- C. The same program under another id (a clone), record verified with no pin.
  const g = await setup(conn, CLONE, 500_000n);
  const sigClone = await charge(g, 100_000n, 1n);
  const recClone = exportTo(sigClone, envClone, "clone-paid");
  const jc = JSON.parse(readFileSync(recClone, "utf8")) as { program_id: string };
  const vcl = verifyPath(recClone);
  check("a record from a program that is not Veto is rejected", vcl.code !== 0, `${verdict(vcl.out)} program_id=${jc.program_id}`);
  const relabelled = mutate(recClone, "clone-relabelled", (r) => { r.program_id = REAL.toBase58(); });
  const vrl = verifyPath(relabelled);
  check("the clone record relabelled with the real program id is rejected", vrl.code !== 0, verdict(vrl.out));

  // --- D. One transaction carrying two charge instructions on the same mandate.
  const h = await setup(conn, REAL, 500_000n);
  const ixA = await chargeIx(h, 600_000n, 7n);
  const ixB = await chargeIx(h, 100_000n, 7n);
  const sigTwo = await send(conn, new Transaction().add(ixA, ixB), [h.agent]);
  const recTwo = exportTo(sigTwo, envReal, "two-charges");
  const jt = JSON.parse(readFileSync(recTwo, "utf8")) as { kind: string; amount: number };
  console.log(`two-charge tx exported as kind=${jt.kind} amount=${jt.amount}`);
  const vt = verifyPath(recTwo);
  check("record exported from a two-charge transaction confirms", vt.code === 0, verdict(vt.out));
  const swapped = mutate(recTwo, "two-charges-claim-paid", (r) => {
    r.kind = "paid"; r.amount = 100000; r.reason_code = 0; r.reason_text = "ok"; r.suggested_override = 0;
  });
  const vs = verifyPath(swapped);
  check("claiming the second (paid) charge under the first's record is rejected", vs.code !== 0, verdict(vs.out));

  console.log(failures > 0 ? `${failures} check(s) did not hold` : "every check held");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(2);
});
