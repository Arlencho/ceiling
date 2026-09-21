import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTerminalConfig } from "./config.js";

const IDENTITIES = {
  VETO_RPC: "http://from-env.test",
  VETO_PROGRAM_ID: "Prog",
  VETO_MINT: "Mint",
  VETO_OWNER: "Owner",
  VETO_OWNER_TOKEN: "OwnerToken",
  VETO_MERCHANT: "Merchant",
  VETO_MERCHANT_TOKEN: "MerchantToken",
  VETO_AGENT: "Agent",
};

test("loadTerminalConfig refuses to invent rpc and merchant accounts", () => {
  const empty = mkdtempSync(join(tmpdir(), "veto-term-cfg-"));
  assert.throws(
    () => loadTerminalConfig({ VETO_KEYS_DIR: empty }),
    /missing VETO_/,
  );
});

test("loadTerminalConfig takes rpc, port and volume from the environment", () => {
  const empty = mkdtempSync(join(tmpdir(), "veto-term-cfg-"));
  const cfg = loadTerminalConfig({
    VETO_KEYS_DIR: empty,
    ...IDENTITIES,
    VETO_TERMINAL_PORT: "9999",
    VETO_KWH_MILLI: "1000",
  });
  assert.equal(cfg.rpc, "http://from-env.test");
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.kwhMilli, 1000n);
  assert.equal(cfg.merchantTokenAccount, "MerchantToken");
});
