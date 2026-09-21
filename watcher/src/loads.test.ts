import { test } from "node:test";
import assert from "node:assert/strict";

// Every module that talks to the chain, loaded for real.
//
// This file exists because `chain.ts` could not load at all on Node 22 for an
// unknown length of time, and nothing noticed. No test imported it, so the
// suite was green while `status` and `once` both failed before main() ran. The
// cause was a named import of BN from anchor's CommonJS build, which Node 26
// resolves and Node 22 rejects, and every seat and every local run was on 26.
//
// A typecheck cannot catch this: the types are correct, the linkage is not.
// Only loading the module under the Node major that CI and the READMEs name
// catches it, so these tests do exactly that and nothing more.

test("chain.ts loads and exports its entry points", async () => {
  const chain = await import("./chain.js");
  for (const name of ["submitCharge", "openMandate"]) {
    assert.equal(typeof (chain as Record<string, unknown>)[name], "function", `${name} is callable`);
  }
});

test("run.ts loads", async () => {
  const run = await import("./run.js");
  assert.ok(Object.keys(run).length > 0, "run exports something");
});
