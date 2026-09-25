import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./commands.js";
import { DEVNET_USDC_MINT } from "./money.js";
import {
  chainOf,
  harness,
  openedWorld,
  output,
  plantDecision,
  removeHome,
  retargetMint,
  saveSetup,
  tempHome,
} from "./testkit.js";

function listed(w: ReturnType<typeof openedWorld>): void {
  retargetMint(w, DEVNET_USDC_MINT);
  plantDecision(w, "older", 10, 100, 500_000n, 1n);
  plantDecision(w, "newer", 20, 200, 1_000_000n, 2n);
  w.fake.signatures = [
    {
      signature: "newer",
      slot: 20,
      err: null,
      memo: null,
      blockTime: 200,
      confirmationStatus: "confirmed",
    },
    {
      signature: "older",
      slot: 10,
      err: null,
      memo: null,
      blockTime: 100,
      confirmationStatus: "confirmed",
    },
  ];
}

test("decisions lists newest first with the token and the signature", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    listed(w);
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["decisions"], runtime);
    assert.equal(code, 0);
    assert.equal(output(runtime), ["paid 1 USDC ok newer", "paid 0.50 USDC ok older"].join("\n"));
  } finally {
    removeHome(home);
  }
});

test("decisions --limit keeps the newest rows", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    listed(w);
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["decisions", "--limit", "1"], runtime);
    assert.equal(code, 0);
    assert.equal(output(runtime), "paid 1 USDC ok newer");
  } finally {
    removeHome(home);
  }
});
