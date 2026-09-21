import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const IDENTITIES = {
  VETO_RPC: "http://rpc.test",
  VETO_PROGRAM_ID: "Prog",
  VETO_MINT: "Mint",
  VETO_OWNER: "Owner",
  VETO_OWNER_TOKEN: "OwnerToken",
  VETO_MERCHANT: "Merchant",
  VETO_MERCHANT_TOKEN: "MerchantToken",
  VETO_AGENT: "Agent",
};

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "veto-config-"));
}

test("loadConfig refuses to invent rpc and account identities", () => {
  const empty = tmpDir();
  assert.throws(
    () => loadConfig({ VETO_KEYS_DIR: empty }, { envFiles: [] }),
    /missing VETO_RPC/,
  );
});

test("loadConfig reads VETO_ keys from the environment", () => {
  const cfg = loadConfig({ ...IDENTITIES, VETO_KEYS_DIR: tmpDir() }, { envFiles: [] });
  assert.equal(cfg.rpc, "http://rpc.test");
  assert.equal(cfg.merchantTokenAccount, "MerchantToken");
  assert.equal(cfg.programId, "Prog");
});

test("loadConfig reads short keys from keys/devnet-addresses.env style files", () => {
  const dir = tmpDir();
  const file = join(dir, "devnet-addresses.env");
  writeFileSync(
    file,
    [
      "RPC=http://from-short.test",
      "PROGRAM_ID=Prog",
      "MINT=Mint",
      "OWNER=Owner",
      "OWNER_TOKEN_ACCOUNT=OwnerToken",
      "MERCHANT=Merchant",
      "MERCHANT_TOKEN_ACCOUNT=MerchantToken",
      "AGENT=Agent",
    ].join("\n"),
  );
  const cfg = loadConfig({ VETO_KEYS_DIR: dir }, { envFiles: [file] });
  assert.equal(cfg.rpc, "http://from-short.test");
  assert.equal(cfg.merchantTokenAccount, "MerchantToken");
});
