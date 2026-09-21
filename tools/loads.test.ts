import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// produce.ts is a script: importing it would run it, so this links it in a child
// process instead and only asserts on how it fails.
//
// This exists because a named import of BN from anchor's CommonJS build links
// on Node 26 and is a SyntaxError on Node 22, the floor the READMEs document
// and the version CI runs. Every seat and every local run was on 26, so the
// suite stayed green while the binary could not start at all. A typecheck
// cannot see this: the types are right, the linkage is not.
//
// Missing keys or config are fine here and expected. A module that cannot be
// linked is not.

test("produce.ts links under this Node version", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = resolve(here, "./produce.ts");
  const out = spawnSync("npx", ["tsx", script], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, VETO_KEYS_DIR: resolve(here, "does-not-exist") },
  });
  const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  for (const marker of ["Named export", "SyntaxError", "ERR_MODULE_NOT_FOUND", "does not provide an export"]) {
    assert.ok(!text.includes(marker), `module linkage failure: ${marker}\n${text.slice(0, 600)}`);
  }
});
