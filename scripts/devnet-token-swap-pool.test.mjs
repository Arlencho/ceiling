// No network. These checks call the pool script's pure helpers and read its source.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AIRDROP_MAX_TRIES,
  ENFORCED_FEES,
  FAUCET_URL,
  FEE_OWNER_ADDRESS,
  POOL_ENV_KEYS,
  PUBLIC_DEVNET,
  REJECTED_FEES,
  SOL_PRICE_SOURCE,
  SOL_PRICE_USD,
  SWAP_IN_BASE,
  USDC_DECIMALS,
  USDC_MINT_ADDRESS,
  USDC_SEED_BASE,
  WSOL_DECIMALS,
  WSOL_MINT_ADDRESS,
  WSOL_SEED_LAMPORTS,
  WSOL_SEED_SOL,
  airdropWaitMs,
  appendAbsentKeys,
  assertSeedCoversSwap,
  endpoint,
  feeWords,
  initializeData,
  lamportsFromSol,
  poolEnvUpdates,
  redact,
  solBoughtByTenUsd,
  swapAccounts,
  swapData,
  usdcShortfallMessage,
} from "./devnet-token-swap-pool-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "devnet-token-swap-pool.ts"), "utf8");
const lib = readFileSync(join(here, "devnet-token-swap-pool-lib.mjs"), "utf8");

let failed = 0;
let passed = 0;
const pass = (name) => {
  console.log(`ok - ${name}`);
  passed += 1;
};
const bad = (name, detail = "") => {
  console.log(`not ok - ${name}${detail ? `: ${detail}` : ""}`);
  failed += 1;
};

if (WSOL_MINT_ADDRESS === "So11111111111111111111111111111111111111112" && WSOL_DECIMALS === 9) {
  pass("wrapped SOL is the nine-decimal mint");
} else {
  bad("wrapped SOL is the nine-decimal mint", `${WSOL_MINT_ADDRESS} decimals ${WSOL_DECIMALS}`);
}

if (USDC_MINT_ADDRESS === "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" && USDC_DECIMALS === 6) {
  pass("Circle devnet USDC is the six-decimal mint");
} else {
  bad("Circle devnet USDC is the six-decimal mint", `${USDC_MINT_ADDRESS} decimals ${USDC_DECIMALS}`);
}

if (FEE_OWNER_ADDRESS === "HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN") {
  pass("the fee account owner is the key compiled into the exchange");
} else {
  bad("the fee account owner is the key compiled into the exchange", FEE_OWNER_ADDRESS);
}

const data = initializeData(7);
const words = [];
for (let i = 0; i < 8; i += 1) words.push(data.readBigUInt64LE(2 + i * 8));
const curveAt = 2 + 64;
if (
  data.length === 99
  && data[0] === 0
  && data[1] === 7
  && data[curveAt] === 0
  && data.subarray(curveAt + 1).equals(Buffer.alloc(32))
) {
  pass("initialize data is tag, bump, curve type 0, and 32 zero bytes");
} else {
  bad("initialize data is tag, bump, curve type 0, and 32 zero bytes", `len ${data.length}`);
}

const expectedWords = [25n, 10_000n, 5n, 10_000n, 0n, 0n, 20n, 100n];
if (words.every((word, i) => word === expectedWords[i]) && feeWords(ENFORCED_FEES).every((word, i) => word === expectedWords[i])) {
  pass("initialize data uses the enforced fee schedule");
} else {
  bad("initialize data uses the enforced fee schedule", words.join(","));
}

if (!initializeData(7).equals(initializeData(7, REJECTED_FEES))) {
  pass("initialize data does not use the rejected owner 0 host 0 schedule");
} else {
  bad("initialize data does not use the rejected owner 0 host 0 schedule");
}

const feeAt = lib.indexOf("export const ENFORCED_FEES");
const feeWindow = lib.slice(Math.max(0, feeAt - 400), feeAt + 80);
if (feeAt > 0 && feeWindow.includes("0x17") && feeWindow.includes("owner 0") && feeWindow.includes("host 0")) {
  pass("the other schedule is named as custom error 0x17");
} else {
  bad("the other schedule is named as custom error 0x17");
}

const roles = swapAccounts();
const onlySigner = roles.filter((role) => role.signer).map((role) => role.role);
const expectedRoles = [
  "swap",
  "authority",
  "delegate",
  "userSource",
  "vaultIn",
  "vaultOut",
  "userDestination",
  "poolMint",
  "feeAccount",
  "tokenProgram",
];
if (
  roles.map((role) => role.role).join(",") === expectedRoles.join(",")
  && onlySigner.length === 1
  && onlySigner[0] === "delegate"
  && roles[3].signer === false
  && !roles.some((role) => role.role === "host" || role.role === "mintA" || role.role === "mintB")
) {
  pass("the swap lists ten accounts, signed by the delegate, with no traded mint and no host");
} else {
  bad("the swap lists ten accounts, signed by the delegate, with no traded mint and no host", roles.map((role) => role.role).join(","));
}

const encoded = swapData(SWAP_IN_BASE, 1n);
if (encoded.length === 17 && encoded[0] === 1 && encoded.readBigUInt64LE(1) === 1_000_000n && encoded.readBigUInt64LE(9) === 1n) {
  pass("the swap pays 0.001 SOL and accepts any positive USDC out");
} else {
  bad("the swap pays 0.001 SOL and accepts any positive USDC out");
}

const updates = poolEnvUpdates({
  pool: "pool-new",
  authority: "auth-new",
  wsolVault: "wsol-new",
  usdcVault: "usdc-new",
  poolMint: "lp-new",
  feeAccount: "fee-new",
});
const before = "CLUSTER=devnet\nTOKEN_SWAP_POOL=pool-old\nTOKEN_SWAP_MINT_B=leftover\n";
const after = appendAbsentKeys(before, updates);
const poolLines = after.split("\n").filter((line) => line.startsWith("TOKEN_SWAP_POOL="));
const mintBLines = after.split("\n").filter((line) => line.startsWith("TOKEN_SWAP_MINT_B="));
if (
  Object.keys(updates).join(",") === POOL_ENV_KEYS.join(",")
  && !Object.prototype.hasOwnProperty.call(updates, "TOKEN_SWAP_MINT_B")
  && poolLines.length === 1
  && poolLines[0] === "TOKEN_SWAP_POOL=pool-old"
  && mintBLines.length === 1
  && mintBLines[0] === "TOKEN_SWAP_MINT_B=leftover"
  && after.includes("TOKEN_SWAP_WSOL_VAULT=wsol-new")
  && after.includes("TOKEN_SWAP_USDC_VAULT=usdc-new")
  && after.includes("TOKEN_SWAP_AUTHORITY=auth-new")
  && after.includes("TOKEN_SWAP_POOL_MINT=lp-new")
  && after.includes("TOKEN_SWAP_FEE_ACCOUNT=fee-new")
  && after.includes("CLUSTER=devnet")
) {
  pass("absent pool keys are appended and TOKEN_SWAP_MINT_B is not written");
} else {
  bad("absent pool keys are appended and TOKEN_SWAP_MINT_B is not written", after);
}

let refusedMintB = false;
try {
  appendAbsentKeys("", { TOKEN_SWAP_MINT_B: "nope" });
} catch (err) {
  refusedMintB = err instanceof Error && err.message.includes("TOKEN_SWAP_MINT_B");
}
if (refusedMintB) pass("the writer refuses TOKEN_SWAP_MINT_B");
else bad("the writer refuses TOKEN_SWAP_MINT_B");

if (
  solBoughtByTenUsd(120.58) === 0.083
  && SOL_PRICE_USD === 120.58
  && SOL_PRICE_SOURCE === "https://api.coinbase.com/v2/prices/SOL-USD/spot"
  && WSOL_SEED_SOL === 0.083
  && WSOL_SEED_LAMPORTS === 83_000_000n
  && lamportsFromSol(0.001) === SWAP_IN_BASE
) {
  pass("ten dollars buys 0.083 SOL at the 120.58 USD price");
} else {
  bad(
    "ten dollars buys 0.083 SOL at the 120.58 USD price",
    `${WSOL_SEED_SOL} ${WSOL_SEED_LAMPORTS}`,
  );
}

try {
  assertSeedCoversSwap(WSOL_SEED_LAMPORTS, SWAP_IN_BASE);
  pass("the SOL seed covers the 0.001 SOL swap");
} catch (err) {
  bad("the SOL seed covers the 0.001 SOL swap", err instanceof Error ? err.message : String(err));
}

if (endpoint({ VETO_RPC: "http://127.0.0.1:8899" }) === "http://127.0.0.1:8899") {
  pass("VETO_RPC is the endpoint when it is set");
} else {
  bad("VETO_RPC is the endpoint when it is set");
}

if (endpoint({}) === PUBLIC_DEVNET && endpoint({ VETO_RPC: "" }) === PUBLIC_DEVNET) {
  pass("an unset VETO_RPC uses the public devnet endpoint");
} else {
  bad("an unset VETO_RPC uses the public devnet endpoint");
}

const secret = "superSecretKey99";
let mainnetMessage = "";
try {
  endpoint({ VETO_RPC: `https://api.mainnet-beta.solana.com/?api-key=${secret}` });
  mainnetMessage = "did not throw";
} catch (err) {
  mainnetMessage = err instanceof Error ? err.message : String(err);
}
if (mainnetMessage.includes("refusing to run against mainnet") && !mainnetMessage.includes(secret)) {
  pass("a mainnet URL is refused without printing an api key");
} else {
  bad("a mainnet URL is refused without printing an api key", mainnetMessage);
}

const redacted = redact(`failed https://rpc.example/secret-path?api-key=${secret}`);
if (!redacted.includes(secret) && redacted.includes("[rpc]")) {
  pass("an rpc url in an error is redacted");
} else {
  bad("an rpc url in an error is redacted", redacted);
}

const short = usdcShortfallMessage("GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1", 999n);
if (
  short.includes(FAUCET_URL)
  && short.includes("GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1")
  && short.includes(String(USDC_SEED_BASE))
  && !short.includes("9999999")
) {
  pass("a short USDC balance names the faucet and the deployer");
} else {
  bad("a short USDC balance names the faucet and the deployer", short);
}

if (airdropWaitMs(1) === 5_000 && airdropWaitMs(AIRDROP_MAX_TRIES) === 60_000 && airdropWaitMs(1) < airdropWaitMs(3)) {
  pass("an airdrop retry waits and then backs off");
} else {
  bad("an airdrop retry waits and then backs off", `${airdropWaitMs(1)} ${airdropWaitMs(AIRDROP_MAX_TRIES)}`);
}

const usesLib = script.includes('from "./devnet-token-swap-pool-lib.mjs"')
  && script.includes("initializeData")
  && script.includes("swapAccounts")
  && script.includes("swapData")
  && script.includes("appendAbsentKeys")
  && script.includes("usdcShortfallMessage")
  && script.includes("createSyncNativeInstruction")
  && script.includes("requestAirdrop");
const dropped = !script.includes("demo mint authority")
  && !script.includes("TOKEN_SWAP_MINT_B")
  && !script.includes("expected 14")
  && !script.includes("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU")
  && !script.includes("second mint");
if (usesLib && dropped) {
  pass("the script uses the enforced schedule, the two mints, and a ten-account swap");
} else {
  bad("the script uses the enforced schedule, the two mints, and a ten-account swap", `usesLib ${usesLib} dropped ${dropped}`);
}

if (failed > 0) process.exit(1);
console.log(`devnet-token-swap-pool checks: ${passed} passed`);
