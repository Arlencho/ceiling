import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, lookupConfigString } from "./config.js";

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
  assert.deepEqual(cfg.rpcs, ["http://rpc.test"]);
});

test("loadConfig reads VETO_ keys from an env file, including volume", () => {
  const dir = tmpDir();
  const file = join(dir, ".env");
  writeFileSync(
    file,
    Object.entries({ ...IDENTITIES, VETO_KWH_MILLI: "1000" })
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const cfg = loadConfig({ VETO_KEYS_DIR: dir }, { envFiles: [file] });
  assert.equal(cfg.rpc, "http://rpc.test");
  assert.equal(cfg.merchantTokenAccount, "MerchantToken");
  assert.equal(cfg.kwhMilli, 1000n);
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

test("loadConfig throws when two env files disagree on volume", () => {
  const dir = tmpDir();
  const a = join(dir, "a.env");
  const b = join(dir, "b.env");
  const body = Object.entries(IDENTITIES)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(a, `${body}\nVETO_KWH_MILLI=50000\n`);
  writeFileSync(b, `${body}\nVETO_KWH_MILLI=1000\n`);
  assert.throws(
    () => loadConfig({ VETO_KEYS_DIR: dir }, { envFiles: [a, b] }),
    /VETO_KWH_MILLI disagrees/,
  );
});

test("lookupConfigString reads VETO_TERMINAL_PORT from a file", () => {
  const dir = tmpDir();
  const file = join(dir, ".env");
  writeFileSync(file, "VETO_TERMINAL_PORT=9999\n");
  const port = lookupConfigString({ VETO_KEYS_DIR: dir }, "VETO_TERMINAL_PORT", { envFiles: [file] });
  assert.equal(port, "9999");
});

test("loadConfig defaults to a local journal file and no Cloud Storage URI", () => {
  const dir = tmpDir();
  const file = join(dir, ".env");
  writeFileSync(
    file,
    Object.entries(IDENTITIES)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const cfg = loadConfig({ VETO_KEYS_DIR: dir }, { envFiles: [file] });
  assert.equal(cfg.journalGcsUri, null);
  assert.match(cfg.journalPath, /decisions\.jsonl$/);
});

test("loadConfig accepts VETO_JOURNAL_GCS and keeps the local path", () => {
  const dir = tmpDir();
  const file = join(dir, ".env");
  writeFileSync(
    file,
    Object.entries(IDENTITIES)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const cfg = loadConfig(
    { VETO_KEYS_DIR: dir, VETO_JOURNAL_GCS: "gs://veto-journal/decisions.jsonl" },
    { envFiles: [file] },
  );
  assert.equal(cfg.journalGcsUri, "gs://veto-journal/decisions.jsonl");
  assert.match(cfg.journalPath, /decisions\.jsonl$/);
});

test("loadConfig refuses a bad VETO_JOURNAL_GCS URI", () => {
  const dir = tmpDir();
  const file = join(dir, ".env");
  writeFileSync(
    file,
    Object.entries(IDENTITIES)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  assert.throws(
    () => loadConfig({ VETO_KEYS_DIR: dir, VETO_JOURNAL_GCS: "gs://bucketonly" }, { envFiles: [file] }),
    /gs:\/\/bucket\/object/,
  );
});
