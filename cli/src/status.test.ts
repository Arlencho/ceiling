import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./commands.js";
import { DEVNET_USDC_MINT } from "./money.js";
import {
  chainOf,
  harness,
  openedWorld,
  output,
  removeHome,
  retargetMint,
  saveSetup,
  tempHome,
} from "./testkit.js";

const EXPIRES = 1793750400n;

function usdcWorld(balance: number) {
  const w = openedWorld({
    cap: 20_000_000n,
    spent: 500_000n,
    perTxMax: 500_000n,
    expiresAt: EXPIRES,
    balance,
  });
  retargetMint(w, DEVNET_USDC_MINT);
  return w;
}

test("status names what the rule can still pay, with the fee warning", async () => {
  const home = tempHome();
  try {
    const w = usdcWorld(50_000);
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["status"], runtime);
    assert.equal(code, 0);
    assert.equal(
      output(runtime),
      [
        "Can still pay 19.50 USDC today",
        "Cap 20 USDC",
        "Largest payment 0.50 USDC",
        "Ends 2026-11-04",
        "Fee SOL 0.00005",
        "agent SOL balance is 50000 lamports, under 100000 lamports (20 base fees of 5000). The agent pays the transaction fee.",
      ].join("\n"),
    );
  } finally {
    removeHome(home);
  }
});

test("status prints the fee SOL without a warning when the balance covers 20 base fees", async () => {
  const home = tempHome();
  try {
    const w = usdcWorld(1_000_000);
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["status"], runtime);
    assert.equal(code, 0);
    assert.equal(
      output(runtime),
      [
        "Can still pay 19.50 USDC today",
        "Cap 20 USDC",
        "Largest payment 0.50 USDC",
        "Ends 2026-11-04",
        "Fee SOL 0.001",
      ].join("\n"),
    );
  } finally {
    removeHome(home);
  }
});
