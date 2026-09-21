import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requiredIdentity } from "./config.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "veto-indexer-config-"));
}

test("requiredIdentity refuses to invent an rpc endpoint", () => {
  const empty = tmpDir();
  assert.throws(
    () => requiredIdentity("VETO_RPC", { VETO_KEYS_DIR: empty }, { envFiles: [] }),
    /missing VETO_RPC/,
  );
});

test("requiredIdentity refuses to invent a program id", () => {
  const empty = tmpDir();
  assert.throws(
    () => requiredIdentity("VETO_PROGRAM_ID", { VETO_KEYS_DIR: empty }, { envFiles: [] }),
    /missing VETO_PROGRAM_ID/,
  );
});

test("requiredIdentity reads a short key from an addresses file", () => {
  const dir = tmpDir();
  const file = join(dir, "devnet-addresses.env");
  writeFileSync(file, "RPC=http://from-short.test\nPROGRAM_ID=Prog\n");
  assert.equal(
    requiredIdentity("VETO_RPC", { VETO_KEYS_DIR: dir }, { envFiles: [file] }),
    "http://from-short.test",
  );
  assert.equal(
    requiredIdentity("VETO_PROGRAM_ID", { VETO_KEYS_DIR: dir }, { envFiles: [file] }),
    "Prog",
  );
});
