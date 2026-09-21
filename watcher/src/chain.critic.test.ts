import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { connect } from "./chain.js";
import { loadConfig } from "./config.js";

// Critic round 1. The program the watcher transacts against must be the
// configured one. Anchor's Program takes its id from idl.address, and the
// bundled IDL carries a constant, so a configured VETO_PROGRAM_ID that is
// not applied to the IDL leaves the instruction addressed to the constant
// while the PDAs derive from the configured id.
const CONFIGURED_PROGRAM = "11111111111111111111111111111111";

const IDENTITIES = {
  VETO_RPC: "http://rpc.test",
  VETO_PROGRAM_ID: CONFIGURED_PROGRAM,
  VETO_MINT: "Mint",
  VETO_OWNER: "Owner",
  VETO_OWNER_TOKEN: "OwnerToken",
  VETO_MERCHANT: "Merchant",
  VETO_MERCHANT_TOKEN: "MerchantToken",
  VETO_AGENT: "Agent",
};

test("the program the watcher signs against is the configured VETO_PROGRAM_ID, not the bundled IDL address", () => {
  const cfg = loadConfig(
    { ...IDENTITIES, VETO_KEYS_DIR: mkdtempSync(join(tmpdir(), "veto-critic-")) },
    { envFiles: [] },
  );
  const { program, programId } = connect(cfg, Keypair.generate());
  assert.equal(programId.toBase58(), CONFIGURED_PROGRAM);
  assert.equal(
    program.programId.toBase58(),
    CONFIGURED_PROGRAM,
    "Anchor Program resolved its id from the bundled IDL, not from configuration",
  );
});
