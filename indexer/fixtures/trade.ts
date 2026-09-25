import { createHash } from "node:crypto";
import { PublicKey, type Connection } from "@solana/web3.js";
const disc = (s: string) =>
  createHash("sha256").update(s).digest().subarray(0, 8);
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
export function tradeFixture(refused = false) {
  const program = key(90),
    owner = key(1),
    agent = key(2);
  const rule = PublicKey.findProgramAddressSync(
    [Buffer.from("trade"), owner.toBuffer(), u64(1n)],
    program,
  )[0];
  const ledger = PublicKey.findProgramAddressSync(
    [Buffer.from("trade-ledger"), rule.toBuffer()],
    program,
  )[0];
  const source = key(3),
    destination = key(4),
    inMint = key(5),
    outMint = key(6);
  const exchange = key(7),
    pool = key(8),
    authority = key(9),
    inVault = key(10),
    outVault = key(11),
    poolMint = key(12),
    fee = key(13);
  const amountIn = 100n,
    amountOut = refused ? 0n : 150n,
    minOut = 120n,
    nonce = 3n;
  const reason = refused ? 14 : 0;
  const ruleData = Buffer.concat([
    disc("account:TradeRule"),
    ...[owner, agent, source, destination, inMint, outMint, exchange].map((k) =>
      k.toBuffer(),
    ),
    Buffer.from([0]),
    ...[pool, authority, inVault, outVault, poolMint, fee].map((k) =>
      k.toBuffer(),
    ),
    ...[
      1n,
      1000n,
      amountIn,
      200n,
      500n,
    ].map(u64),
    ...Array.from({ length: 25 }, (_, i) => Buffer.concat([u64(BigInt(i)), u64(i === 0 ? amountIn : 0n)])),
    ...[
      1n,
      1n,
      2000n,
      0n,
      0n,
      nonce,
    ].map(u64),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from("test"),
    Buffer.from([1]),
    Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 255]),
  ]);
  const ledgerData = Buffer.alloc(48 + 32 * 88);
  disc("account:TradeLedger").copy(ledgerData);
  rule.toBuffer().copy(ledgerData, 8);
  ledgerData.writeUInt32LE(1, 40);
  ledgerData.writeUInt16LE(1, 44);
  Buffer.concat([
    u64(1000n),
    u64(amountIn),
    u64(amountOut),
    u64(minOut),
    pool.toBuffer(),
    u64(nonce),
    u64(0n),
    Buffer.from([refused ? 2 : 1, reason]),
  ]).copy(ledgerData, 48);
  const event = Buffer.concat([
    disc(refused ? "event:TradeRefused" : "event:Traded"),
    rule.toBuffer(),
    u64(amountIn),
    u64(refused ? minOut : amountOut),
    u64(nonce),
    ...(refused ? [Buffer.from([reason]), u64(0n)] : [u64(amountIn)]),
  ]);
  const keys = [
    agent,
    rule,
    ledger,
    source,
    destination,
    exchange,
    pool,
    authority,
    inVault,
    outVault,
    poolMint,
    fee,
    key(14),
    program,
  ];
  const data = Buffer.concat([
    disc("global:trade"),
    u64(amountIn),
    u64(minOut),
    u64(nonce),
  ]);
  const logs = [
    `Program ${program} invoke [1]`,
    `Program data: ${event.toString("base64")}`,
    `Program ${program} success`,
  ];
  const tx = {
    slot: 1,
    blockTime: 1000,
    meta: { err: null, logMessages: logs },
    transaction: {
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [
          {
            programIdIndex: 13,
            accountKeyIndexes: keys.slice(0, 13).map((_, i) => i),
            data,
          },
        ],
      },
    },
  };
  const signature = "1".repeat(64);
  const view = {
    signature,
    slot: 1,
    blockTime: 1000,
    err: null,
    logs,
    accountKeys: keys.map(String),
    instructions: [
      {
        programId: String(program),
        accounts: keys.slice(0, 13).map(String),
        data,
      },
    ],
  };
  const conn = {
    getGenesisHash: async () => "fixture-genesis",
    getAccountInfo: async (address: PublicKey) =>
      address.equals(rule)
        ? { owner: program, data: ruleData }
        : address.equals(ledger)
          ? { owner: program, data: ledgerData }
          : null,
    getTransaction: async () => tx,
    getSignaturesForAddress: async (
      _address: PublicKey,
      opts: { before?: string },
    ) =>
      opts?.before ? [] : [{ signature, slot: 1, blockTime: 1000, err: null, memo: null }],
  } as unknown as Connection;
  return {
    program,
    rule,
    ledger,
    pool,
    signature,
    tx,
    view,
    conn,
    ruleData,
    ledgerData,
    event,
  };
}
