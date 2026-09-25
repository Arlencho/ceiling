// Pure pieces of the devnet pool script. No network, no key files.
// The other schedule, owner 0 and host 0, is rejected with custom error 0x17.

export const TOKEN_SWAP_PROGRAM_ADDRESS = "SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8";
export const WSOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
export const USDC_MINT_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const FEE_OWNER_ADDRESS = "HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN";
export const WSOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
export const USDC_SEED_BASE = 10_000_000n;
export const SWAP_IN_BASE = 1_000_000n;
export const PUBLIC_DEVNET = "https://api.devnet.solana.com";
export const FAUCET_URL = "https://faucet.circle.com";
export const AIRDROP_MAX_TRIES = 12;

// Public SOL price read on 2026-09-25.
// Source: https://api.coinbase.com/v2/prices/SOL-USD/spot
// Number: 120.58 USD per SOL. 10 USD buys 0.083 SOL.
export const SOL_PRICE_USD = 120.58;
export const SOL_PRICE_SOURCE = "https://api.coinbase.com/v2/prices/SOL-USD/spot";

// The only schedule this program accepts, copied from ENFORCED_FEES in
// programs/veto/tests/token_swap_fixture.rs. Trade 25/10000, owner trade
// 5/10000, owner withdraw 0/0, host 20/100. The other schedule, owner 0 and
// host 0, is rejected with custom error 0x17.
export const ENFORCED_FEES = {
  tradeNumerator: 25n,
  tradeDenominator: 10_000n,
  ownerTradeNumerator: 5n,
  ownerTradeDenominator: 10_000n,
  ownerWithdrawNumerator: 0n,
  ownerWithdrawDenominator: 0n,
  hostNumerator: 20n,
  hostDenominator: 100n,
};

export const REJECTED_FEES = {
  tradeNumerator: 25n,
  tradeDenominator: 10_000n,
  ownerTradeNumerator: 0n,
  ownerTradeDenominator: 0n,
  ownerWithdrawNumerator: 0n,
  ownerWithdrawDenominator: 0n,
  hostNumerator: 0n,
  hostDenominator: 0n,
};

export const POOL_ENV_KEYS = [
  "TOKEN_SWAP_POOL",
  "TOKEN_SWAP_AUTHORITY",
  "TOKEN_SWAP_WSOL_VAULT",
  "TOKEN_SWAP_USDC_VAULT",
  "TOKEN_SWAP_POOL_MINT",
  "TOKEN_SWAP_FEE_ACCOUNT",
];

export const WSOL_SEED_SOL = solBoughtByTenUsd(SOL_PRICE_USD);
export const WSOL_SEED_LAMPORTS = lamportsFromSol(WSOL_SEED_SOL);

function pushU64(bytes, value) {
  const word = Buffer.alloc(8);
  word.writeBigUInt64LE(BigInt(value));
  for (const b of word) bytes.push(b);
}

export function feeWords(fees = ENFORCED_FEES) {
  return [
    fees.tradeNumerator,
    fees.tradeDenominator,
    fees.ownerTradeNumerator,
    fees.ownerTradeDenominator,
    fees.ownerWithdrawNumerator,
    fees.ownerWithdrawDenominator,
    fees.hostNumerator,
    fees.hostDenominator,
  ].map((word) => BigInt(word));
}

export function initializeData(nonce, fees = ENFORCED_FEES) {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 255) {
    throw new Error(`authority bump ${nonce} is not a byte`);
  }
  const bytes = [0, nonce];
  for (const word of feeWords(fees)) pushU64(bytes, word);
  bytes.push(0);
  for (let i = 0; i < 32; i += 1) bytes.push(0);
  if (bytes.length !== 99) {
    throw new Error(`initialize data length ${bytes.length}, expected 99`);
  }
  return Buffer.from(bytes);
}

export function swapData(amountIn, minimumOut) {
  const data = Buffer.alloc(17);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 1);
  data.writeBigUInt64LE(BigInt(minimumOut), 9);
  return data;
}

// Ten accounts. This program reads an optional host fee account after these
// and we never pass one. There are no mint accounts in this list.
export function swapAccounts() {
  return [
    { role: "swap", signer: false, writable: false },
    { role: "authority", signer: false, writable: false },
    { role: "delegate", signer: true, writable: false },
    { role: "userSource", signer: false, writable: true },
    { role: "vaultIn", signer: false, writable: true },
    { role: "vaultOut", signer: false, writable: true },
    { role: "userDestination", signer: false, writable: true },
    { role: "poolMint", signer: false, writable: true },
    { role: "feeAccount", signer: false, writable: true },
    { role: "tokenProgram", signer: false, writable: false },
  ];
}

export function solBoughtByTenUsd(priceUsd) {
  const price = Number(priceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("SOL price must be a positive number");
  }
  return Math.round((10 / price) * 1000) / 1000;
}

export function lamportsFromSol(sol) {
  const whole = Number(sol);
  if (!Number.isFinite(whole) || whole < 0) {
    throw new Error("SOL amount must be a non-negative number");
  }
  const lamports = Math.round(whole * 1_000_000_000);
  if (!Number.isSafeInteger(lamports)) {
    throw new Error("SOL amount does not fit in lamports");
  }
  return BigInt(lamports);
}

export function assertSeedCoversSwap(seedLamports, swapLamports) {
  if (BigInt(seedLamports) <= BigInt(swapLamports)) {
    throw new Error(`SOL seed ${seedLamports} does not cover a swap of ${swapLamports}`);
  }
}

export function poolEnvUpdates(values) {
  const updates = {
    TOKEN_SWAP_POOL: values.pool,
    TOKEN_SWAP_AUTHORITY: values.authority,
    TOKEN_SWAP_WSOL_VAULT: values.wsolVault,
    TOKEN_SWAP_USDC_VAULT: values.usdcVault,
    TOKEN_SWAP_POOL_MINT: values.poolMint,
    TOKEN_SWAP_FEE_ACCOUNT: values.feeAccount,
  };
  const keys = Object.keys(updates);
  if (keys.length !== POOL_ENV_KEYS.length || keys.some((key, i) => key !== POOL_ENV_KEYS[i])) {
    throw new Error("pool env keys drifted");
  }
  return updates;
}

export function appendAbsentKeys(text, updates) {
  let next = String(text);
  for (const [key, value] of Object.entries(updates)) {
    if (key === "TOKEN_SWAP_MINT_B") {
      throw new Error("TOKEN_SWAP_MINT_B must not be written");
    }
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(next)) continue;
    if (next.length > 0 && !next.endsWith("\n")) next += "\n";
    next += `${key}=${value}\n`;
  }
  return next;
}

export function redact(text) {
  return String(text).replace(/https?:\/\/[^\s'")]+/g, "[rpc]");
}

export function endpoint(env = process.env) {
  const raw = env.VETO_RPC;
  const chosen = raw && String(raw).length > 0 ? String(raw) : PUBLIC_DEVNET;
  let parsed;
  try {
    parsed = new URL(chosen);
  } catch {
    throw new Error("VETO_RPC is not a URL");
  }
  if (/mainnet/i.test(parsed.hostname) || /mainnet/i.test(parsed.pathname)) {
    throw new Error("refusing to run against mainnet");
  }
  return chosen;
}

export function usdcShortfallMessage(deployer, have) {
  return `deployer ${deployer} holds ${have} USDC base units, need ${USDC_SEED_BASE}. Get devnet USDC at ${FAUCET_URL}`;
}

export function airdropLamports(attempt) {
  if (attempt <= 4) return 1_000_000_000;
  return 500_000_000;
}

export function airdropWaitMs(attempt) {
  return Math.min(60_000, 5_000 * attempt);
}
