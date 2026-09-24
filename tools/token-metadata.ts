import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  clusterForGenesis,
  connection,
  parseArgs,
  redactRpcUrl,
  resolveRpcList,
} from "./lib.js";

// Metadata program instruction numbers. 33 creates the account (v3).
// 15 updates it (v2). An empty option is a single zero byte.
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const CREATE_DISCRIMINATOR = 33;
const UPDATE_DISCRIMINATOR = 15;
const METADATA_KEY = 4;
const MAX_NAME_LENGTH = 32;
const MAX_SYMBOL_LENGTH = 10;
const MAX_URI_LENGTH = 200;

export { TOKEN_METADATA_PROGRAM_ID, METADATA_KEY };

export const TEST_MINT = new PublicKey("2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
export const TOKEN_NAME = "Veto test token";
export const TOKEN_SYMBOL = "VTEST";
export const TOKEN_URI = "https://raw.githubusercontent.com/Arlencho/veto/main/assets/token/vtest.json";

export type MetadataAccount = {
  data: Uint8Array;
  owner: PublicKey;
};

export type MetadataReader = {
  getAccountInfo(address: PublicKey): Promise<MetadataAccount | null>;
};

export type TokenMetadataPlan = {
  action: "create" | "update";
  metadata: PublicKey;
  instruction: TransactionInstruction;
};

export type DecodedTokenMetadata = {
  name: string;
  symbol: string;
  uri: string;
  updateAuthority: string;
  mint: string;
};

export function metadataPda(mint: PublicKey = TEST_MINT): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );
  return pda;
}

function usage(): never {
  console.error(`write Metaplex metadata for the devnet test mint

Usage:
  VETO_MINT_AUTHORITY_KEYPAIR=<file> npx tsx token-metadata.ts [--rpc url]

The file is the mint authority keypair. This command reads that path from
VETO_MINT_AUTHORITY_KEYPAIR and does not take a key from the repo.
Name ${TOKEN_NAME}, symbol ${TOKEN_SYMBOL}.
Uri ${TOKEN_URI}.
`);
  process.exit(2);
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function assertFieldLengths(): void {
  const name = Buffer.byteLength(TOKEN_NAME);
  const symbol = Buffer.byteLength(TOKEN_SYMBOL);
  const uri = Buffer.byteLength(TOKEN_URI);
  if (name > MAX_NAME_LENGTH || symbol > MAX_SYMBOL_LENGTH || uri > MAX_URI_LENGTH) {
    throw new Error(
      `token-metadata: name ${name}, symbol ${symbol}, or uri ${uri} exceeds the metadata limits (${MAX_NAME_LENGTH}, ${MAX_SYMBOL_LENGTH}, ${MAX_URI_LENGTH})`,
    );
  }
}

function dataV2(): Buffer {
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(0, 0);
  return Buffer.concat([
    borshString(TOKEN_NAME),
    borshString(TOKEN_SYMBOL),
    borshString(TOKEN_URI),
    fee,
    // creators, collection, uses: none
    Buffer.from([0, 0, 0]),
  ]);
}

function createInstruction(
  metadata: PublicKey,
  mint: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([CREATE_DISCRIMINATOR]),
    dataV2(),
    // mutable, no collection details
    Buffer.from([1, 0]),
  ]);
  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function updateInstruction(metadata: PublicKey, authority: PublicKey): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([UPDATE_DISCRIMINATOR, 1]),
    dataV2(),
    // leave update authority, primary sale, and mutability as they are
    Buffer.from([0, 0, 0]),
  ]);
  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export async function planTokenMetadata(
  reader: MetadataReader,
  input: { mint: PublicKey; authority: PublicKey; payer: PublicKey },
): Promise<TokenMetadataPlan> {
  assertFieldLengths();
  const metadata = metadataPda(input.mint);
  const existing = await reader.getAccountInfo(metadata);
  if (existing === null) {
    return {
      action: "create",
      metadata,
      instruction: createInstruction(metadata, input.mint, input.authority, input.payer),
    };
  }
  if (!existing.owner.equals(TOKEN_METADATA_PROGRAM_ID)) {
    throw new Error(
      `token-metadata: ${metadata.toBase58()} is owned by ${existing.owner.toBase58()}, not the metadata program`,
    );
  }
  if (existing.data.length < 1 || existing.data[0] !== METADATA_KEY) {
    throw new Error(`token-metadata: ${metadata.toBase58()} is not a metadata account`);
  }
  return {
    action: "update",
    metadata,
    instruction: updateInstruction(metadata, input.authority),
  };
}

function readString(data: Buffer, offset: number): [string, number] {
  if (offset + 4 > data.length) {
    throw new Error("token-metadata: metadata account ended before a string");
  }
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > data.length) {
    throw new Error("token-metadata: metadata string runs past the account");
  }
  const text = data.subarray(start, end).toString("utf8").replace(/\0+$/g, "");
  return [text, end];
}

export function decodeTokenMetadata(raw: Uint8Array): DecodedTokenMetadata {
  const data = Buffer.from(raw);
  if (data.length < 65 || data[0] !== METADATA_KEY) {
    throw new Error("token-metadata: account is not metadata");
  }
  const updateAuthority = new PublicKey(data.subarray(1, 33)).toBase58();
  const mint = new PublicKey(data.subarray(33, 65)).toBase58();
  let offset = 65;
  let name: string;
  let symbol: string;
  let uri: string;
  [name, offset] = readString(data, offset);
  [symbol, offset] = readString(data, offset);
  [uri, offset] = readString(data, offset);
  return { name, symbol, uri, updateAuthority, mint };
}

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) {
    throw new Error(`token-metadata: missing keypair file ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`token-metadata: ${path} is not a JSON keypair`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((n) => typeof n !== "number")) {
    throw new Error(`token-metadata: ${path} is not a 64-byte keypair`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function explain(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const withLogs = err as Error & { logs?: string[] };
  return withLogs.logs && withLogs.logs.length > 0 ? `${err.message}\n${withLogs.logs.join("\n")}` : err.message;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.flags.help || cli.flags.h) usage();

  const keyPath = process.env.VETO_MINT_AUTHORITY_KEYPAIR;
  if (!keyPath) {
    throw new Error("token-metadata: set VETO_MINT_AUTHORITY_KEYPAIR to the mint authority keypair file");
  }
  const authority = loadKeypair(keyPath);
  const rpcs = resolveRpcList(cli);
  for (const rpc of rpcs) {
    if (rpc.toLowerCase().includes("mainnet")) {
      throw new Error(`token-metadata: refusing mainnet rpc ${redactRpcUrl(rpc)}`);
    }
  }

  const conn = connection(rpcs);
  const genesis = await conn.getGenesisHash();
  const cluster = clusterForGenesis(genesis);
  if (cluster !== "devnet") {
    throw new Error(`token-metadata: genesis ${genesis} is ${cluster}, not devnet`);
  }

  const mintState = await getMint(conn, TEST_MINT, "confirmed", TOKEN_PROGRAM_ID);
  if (!mintState.mintAuthority) {
    throw new Error("token-metadata: the mint has no mint authority");
  }
  if (!mintState.mintAuthority.equals(authority.publicKey)) {
    throw new Error(
      `token-metadata: signer ${authority.publicKey.toBase58()} is not the mint authority ${mintState.mintAuthority.toBase58()}`,
    );
  }

  const plan = await planTokenMetadata(
    {
      getAccountInfo: async (address) => {
        const info = await conn.getAccountInfo(address, "confirmed");
        if (!info) return null;
        return { data: info.data, owner: info.owner };
      },
    },
    { mint: TEST_MINT, authority: authority.publicKey, payer: authority.publicKey },
  );

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: authority.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(plan.instruction);
  const signature = await sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });

  const written = await conn.getAccountInfo(plan.metadata, "confirmed");
  if (!written) {
    throw new Error("token-metadata: metadata account was not found after the transaction");
  }
  const decoded = decodeTokenMetadata(written.data);
  process.stdout.write(
    [
      `action: ${plan.action}`,
      `signature: ${signature}`,
      `metadata: ${plan.metadata.toBase58()}`,
      `name: ${decoded.name}`,
      `symbol: ${decoded.symbol}`,
      `uri: ${decoded.uri}`,
      `update_authority: ${decoded.updateAuthority}`,
      `mint: ${decoded.mint}`,
      `cluster: ${cluster}`,
      "",
    ].join("\n"),
  );
  if (decoded.name !== TOKEN_NAME || decoded.symbol !== TOKEN_SYMBOL || decoded.uri !== TOKEN_URI) {
    throw new Error("token-metadata: read back did not match the name, symbol, and uri that were written");
  }
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  main().catch((err: unknown) => {
    console.error(`token-metadata failed: ${explain(err)}`);
    process.exit(1);
  });
}
