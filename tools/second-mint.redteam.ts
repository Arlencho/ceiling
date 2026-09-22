// Security fixture for the second mandate (PR #111). Read-only against devnet.
//
// Proves, without any private key, that the second mandate cannot reach the
// first mandate's source account and that each agent key is bound to exactly
// one mandate. Every attack is a `charge` instruction simulated with signature
// verification off, so the program's own account constraints are what refuse
// it. A legitimate charge is simulated as a control so a missing error would be
// visible as a difference, not as silence.
//
// Run: VETO_RPC=https://api.devnet.solana.com npx tsx second-mint.redteam.ts
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  CHARGE_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  decodeLedger,
  decodeMandate,
  ledgerPda,
  mandatePda,
  u64Le,
} from "./lib.js";

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const FIRST = {
  mandate: new PublicKey("GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG"),
  mint: new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU"),
  source: new PublicKey("FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE"),
  merchantToken: new PublicKey("2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F"),
  agent: new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w"),
};
const SECOND = {
  mandate: new PublicKey("7Bns2EMrzw9T8apGLRGynean4mkFMwHsEWoXbeTGnNtj"),
  mint: new PublicKey("Dcbba8YzbTXM1HQ9EeHW7M21T1Ce5PiBsY1Bpxx5K3Kq"),
  source: new PublicKey("66RkDwxF51Vzx6Yc7PAGoqkMY6X6bn74gXjT1CiMLhaV"),
  merchantToken: new PublicKey("CFNBvHYNENESCc5JYymYJhm2p7agHRUYDbf1Uqj2GKc8"),
  agent: new PublicKey("77KyczSc3sxceuAXiqx2zGMqvGpWBGNqLg99gHn4hKa9"),
};

type ChargeAccounts = {
  agent: PublicKey;
  mandate: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  mint: PublicKey;
};

function chargeIx(a: ChargeAccounts, amount: bigint, nonce: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: a.agent, isSigner: true, isWritable: false },
      { pubkey: a.mandate, isSigner: false, isWritable: true },
      { pubkey: ledgerPda(PROGRAM, a.mandate), isSigner: false, isWritable: true },
      { pubkey: a.source, isSigner: false, isWritable: true },
      { pubkey: a.destination, isSigner: false, isWritable: true },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(amount), u64Le(nonce)]),
  });
}

async function simulate(conn: Connection, a: ChargeAccounts, amount: bigint, nonce: bigint) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: a.agent,
    recentBlockhash: blockhash,
    instructions: [chargeIx(a, amount, nonce)],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const res = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const logs = res.value.logs ?? [];
  const errLine = logs.find((l) => /Error Code|AnchorError|custom program error/.test(l)) ?? "";
  const vetoLine = logs.find((l) => /VETO (PAID|REFUSED)/.test(l)) ?? "";
  return { err: res.value.err, errLine, vetoLine };
}

async function main() {
  const rpc = process.env.VETO_RPC;
  if (!rpc) throw new Error("set VETO_RPC");
  if (rpc.toLowerCase().includes("mainnet")) throw new Error("refusing mainnet");
  const conn = new Connection(rpc, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`genesis ${genesis} is not devnet`);

  let failures = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  };

  // 1. Distinct PDAs, ledgers, sources, agents, mints. Decoded from chain.
  const [m1, m2] = await Promise.all([
    conn.getAccountInfo(FIRST.mandate, "confirmed"),
    conn.getAccountInfo(SECOND.mandate, "confirmed"),
  ]);
  if (!m1 || !m2) throw new Error("mandate account missing");
  const d1 = decodeMandate(Buffer.from(m1.data));
  const d2 = decodeMandate(Buffer.from(m2.data));
  check("first mandate PDA rederives from its own seeds",
    mandatePda(PROGRAM, d1.owner, d1.mandateId).equals(FIRST.mandate), `mandate_id=${d1.mandateId}`);
  check("second mandate PDA rederives from its own seeds",
    mandatePda(PROGRAM, d2.owner, d2.mandateId).equals(SECOND.mandate), `mandate_id=${d2.mandateId}`);
  check("mandate ids differ", d1.mandateId !== d2.mandateId, `${d1.mandateId} vs ${d2.mandateId}`);
  check("mints differ", !d1.mint.equals(d2.mint), `${d1.mint.toBase58()} vs ${d2.mint.toBase58()}`);
  check("sources differ", !d1.source.equals(d2.source), `${d1.source.toBase58()} vs ${d2.source.toBase58()}`);
  check("agents differ", !d1.agent.equals(d2.agent), `${d1.agent.toBase58()} vs ${d2.agent.toBase58()}`);
  check("second agent is not the owner", !d2.agent.equals(d2.owner), d2.agent.toBase58());
  check("second mandate names the expected mint/source/agent",
    d2.mint.equals(SECOND.mint) && d2.source.equals(SECOND.source) && d2.agent.equals(SECOND.agent), "");
  check("first mandate is untouched (mint/source/agent/cap/spent)",
    d1.mint.equals(FIRST.mint) && d1.source.equals(FIRST.source) && d1.agent.equals(FIRST.agent),
    `cap=${d1.cap} spent=${d1.spent} last_nonce=${d1.lastNonce}`);

  const l1addr = ledgerPda(PROGRAM, FIRST.mandate);
  const l2addr = ledgerPda(PROGRAM, SECOND.mandate);
  const [l1, l2] = await Promise.all([
    conn.getAccountInfo(l1addr, "confirmed"),
    conn.getAccountInfo(l2addr, "confirmed"),
  ]);
  if (!l1 || !l2) throw new Error("ledger account missing");
  const r1 = decodeLedger(Buffer.from(l1.data));
  const r2 = decodeLedger(Buffer.from(l2.data));
  check("ledgers are distinct accounts", !l1addr.equals(l2addr), `${l1addr.toBase58()} vs ${l2addr.toBase58()}`);
  check("first ledger points at first mandate", r1.mandate.equals(FIRST.mandate), `total=${r1.total}`);
  check("second ledger points at second mandate", r2.mandate.equals(SECOND.mandate), `total=${r2.total}`);

  // 2. Delegates on the two source accounts (classic layout: option at 72, key at 76).
  const [s1, s2] = await Promise.all([
    conn.getAccountInfo(FIRST.source, "confirmed"),
    conn.getAccountInfo(SECOND.source, "confirmed"),
  ]);
  if (!s1 || !s2) throw new Error("source account missing");
  const delegateOf = (data: Buffer) =>
    data.readUInt32LE(72) === 0 ? null : new PublicKey(data.subarray(76, 108));
  const del1 = delegateOf(Buffer.from(s1.data));
  const del2 = delegateOf(Buffer.from(s2.data));
  check("first source delegate is exactly the first mandate", !!del1 && del1.equals(FIRST.mandate), del1?.toBase58() ?? "unset");
  check("second source delegate is exactly the second mandate", !!del2 && del2.equals(SECOND.mandate), del2?.toBase58() ?? "unset");
  check("first source delegate is not the second mandate", !del1 || !del1.equals(SECOND.mandate), "");

  // 3. Attacks. Each must fail at the program's account constraints.
  const nonce = d2.lastNonce + 1n;
  const attacks: Array<[string, ChargeAccounts, RegExp]> = [
    ["second agent charges the FIRST mandate",
      { agent: SECOND.agent, mandate: FIRST.mandate, source: FIRST.source, destination: FIRST.merchantToken, mint: FIRST.mint },
      /NotTheAgent/],
    ["first agent charges the SECOND mandate",
      { agent: FIRST.agent, mandate: SECOND.mandate, source: SECOND.source, destination: SECOND.merchantToken, mint: SECOND.mint },
      /NotTheAgent/],
    ["second mandate pointed at the FIRST source and mint",
      { agent: SECOND.agent, mandate: SECOND.mandate, source: FIRST.source, destination: FIRST.merchantToken, mint: FIRST.mint },
      /MintMismatch|SourceMismatch/],
    ["second mandate with its own mint but the FIRST source",
      { agent: SECOND.agent, mandate: SECOND.mandate, source: FIRST.source, destination: SECOND.merchantToken, mint: SECOND.mint },
      /SourceMismatch/],
    ["second mandate paying into a FIRST-mint destination",
      { agent: SECOND.agent, mandate: SECOND.mandate, source: SECOND.source, destination: FIRST.merchantToken, mint: SECOND.mint },
      /MintMismatch/],
  ];
  for (const [name, accounts, want] of attacks) {
    const r = await simulate(conn, accounts, 1_000_000n, nonce);
    check(`attack refused: ${name}`, r.err !== null && want.test(r.errLine), r.errLine || JSON.stringify(r.err));
  }

  // 4. Control: the legitimate second charge simulates as a paid decision.
  const ctl = await simulate(conn,
    { agent: SECOND.agent, mandate: SECOND.mandate, source: SECOND.source, destination: SECOND.merchantToken, mint: SECOND.mint },
    1_000_000n, nonce);
  check("control: legitimate second charge simulates as PAID", ctl.err === null && /VETO PAID/.test(ctl.vetoLine), ctl.vetoLine || JSON.stringify(ctl.err));

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("all checks passed");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
