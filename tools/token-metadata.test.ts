import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  METADATA_KEY,
  TEST_MINT,
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  TOKEN_URI,
  decodeTokenMetadata,
  metadataPda,
  planTokenMetadata,
  type MetadataReader,
} from "./token-metadata.js";

// UpdateMetadataAccountV2 for this name, symbol, and uri.
// Discriminator 15, a present data field, then three empty options.
const UPDATE_DATA =
  "0f010f0000005665746f207465737420746f6b656e0500000056544553544c00000068747470733a2f2f7261772e67697468756275736572636f6e74656e742e636f6d2f41726c656e63686f2f7665746f2f6d61696e2f6173736574732f746f6b656e2f76746573742e6a736f6e0000000000000000";

const CREATE_DATA =
  "210f0000005665746f207465737420746f6b656e0500000056544553544c00000068747470733a2f2f7261772e67697468756275736572636f6e74656e742e636f6d2f41726c656e63686f2f7665746f2f6d61696e2f6173736574732f746f6b656e2f76746573742e6a736f6e00000000000100";

function reader(existing: boolean): MetadataReader {
  const metadata = metadataPda(TEST_MINT);
  return {
    async getAccountInfo(address: PublicKey) {
      if (!existing || !address.equals(metadata)) return null;
      return { data: Uint8Array.of(METADATA_KEY), owner: TOKEN_METADATA_PROGRAM_ID };
    },
  };
}

test("when the metadata account is already present, the plan updates it with the test token name", async () => {
  const authority = Keypair.generate();
  const plan = await planTokenMetadata(reader(true), {
    mint: TEST_MINT,
    authority: authority.publicKey,
    payer: authority.publicKey,
  });
  assert.equal(plan.action, "update");
  assert.equal(plan.instruction.data.toString("hex"), UPDATE_DATA);
  assert.equal(plan.instruction.keys[0]?.pubkey.toBase58(), metadataPda(TEST_MINT).toBase58());
  assert.equal(plan.instruction.keys[0]?.isWritable, true);
  assert.equal(plan.instruction.keys[1]?.pubkey.toBase58(), authority.publicKey.toBase58());
  assert.equal(plan.instruction.keys[1]?.isSigner, true);
});

test("when the metadata account is missing, the plan creates it for the test mint", async () => {
  const authority = Keypair.generate();
  const plan = await planTokenMetadata(reader(false), {
    mint: TEST_MINT,
    authority: authority.publicKey,
    payer: authority.publicKey,
  });
  assert.equal(plan.action, "create");
  assert.equal(plan.instruction.data.toString("hex"), CREATE_DATA);
  assert.equal(plan.instruction.keys[1]?.pubkey.toBase58(), TEST_MINT.toBase58());
  assert.equal(plan.instruction.keys[2]?.pubkey.toBase58(), authority.publicKey.toBase58());
  assert.equal(plan.instruction.keys[2]?.isSigner, true);
});

test("a padded metadata account reads back as the token name, symbol, and uri", () => {
  const authority = Keypair.generate().publicKey;
  function padded(text: string, width: number): Buffer {
    const body = Buffer.alloc(width);
    Buffer.from(text, "utf8").copy(body);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(width, 0);
    return Buffer.concat([len, body]);
  }
  const account = Buffer.concat([
    Buffer.from([METADATA_KEY]),
    authority.toBuffer(),
    TEST_MINT.toBuffer(),
    padded(TOKEN_NAME, 32),
    padded(TOKEN_SYMBOL, 10),
    padded(TOKEN_URI, 200),
  ]);
  const decoded = decodeTokenMetadata(account);
  assert.equal(decoded.name, TOKEN_NAME);
  assert.equal(decoded.symbol, TOKEN_SYMBOL);
  assert.equal(decoded.uri, TOKEN_URI);
  assert.equal(decoded.updateAuthority, authority.toBase58());
  assert.equal(decoded.mint, TEST_MINT.toBase58());
});

test("the token json names the same devnet test token the metadata writes", () => {
  const file = new URL("../assets/token/vtest.json", import.meta.url);
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    name: string;
    symbol: string;
    description: string;
    image: string;
  };
  assert.equal(json.name, TOKEN_NAME);
  assert.equal(json.symbol, TOKEN_SYMBOL);
  assert.equal(json.description, "A devnet test token with no value.");
  assert.equal(json.image, "https://raw.githubusercontent.com/Arlencho/veto/main/assets/token/vtest.png");
  assert.equal(TOKEN_URI, "https://raw.githubusercontent.com/Arlencho/veto/main/assets/token/vtest.json");
});
