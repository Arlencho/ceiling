import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../../watcher/src/config.js";

// Critic round 3 (post-merge). The merge brought in terminal/.env as a file
// the shared loader searches, and terminal/README.md points an operator at
// .env.example for it. Copied into place in an otherwise empty environment,
// that example must supply no identity, the same rule the watcher and
// indexer examples already meet: the loader throws and names the variable.
const TERMINAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = join(TERMINAL_DIR, ".env.example");

test("terminal/.env.example copied into place does not resolve VETO_RPC", () => {
  assert.throws(
    () => loadConfig({ VETO_KEYS_DIR: mkdtempSync(join(tmpdir(), "veto-critic-r3-")) }, { envFiles: [EXAMPLE] }),
    /missing VETO_RPC/,
  );
});
