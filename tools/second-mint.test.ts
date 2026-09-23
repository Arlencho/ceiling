import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  DEVNET_GENESIS,
  PROTECTED_FIRST_MINT,
  PROTECTED_FIRST_SOURCE,
  SECOND_PURPOSE,
  SKR_MINT,
  assertSecondMintAllowed,
  readTokenDelegate,
} from "./second-mint.js";

const ok = {
  rpcUrls: ["https://api.devnet.solana.com"],
  genesis: DEVNET_GENESIS,
  firstMint: PROTECTED_FIRST_MINT,
  secondMint: Keypair.generate().publicKey.toBase58(),
  firstSource: PROTECTED_FIRST_SOURCE,
  secondSource: Keypair.generate().publicKey.toBase58(),
  skrMint: SKR_MINT,
};

test("a second mint is allowed only on devnet, and only when it is neither the first mint nor SKR", () => {
  assert.doesNotThrow(() => assertSecondMintAllowed(ok));
});

test("a mainnet rpc is refused before any mint is created", () => {
  assert.throws(
    () => assertSecondMintAllowed({ ...ok, rpcUrls: ["https://api.mainnet-beta.solana.com"] }),
    /refusing mainnet rpc/,
  );
});

test("a mainnet refusal prints the host and leaves the key out of the message", () => {
  const raw = "https://mainnet.example.test/SECRETPATH?api-key=SECRET123";
  assert.throws(
    () => assertSecondMintAllowed({ ...ok, rpcUrls: [raw] }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message, "second-mint: refusing mainnet rpc https://mainnet.example.test");
      return true;
    },
  );
});

test("a cluster whose genesis is not devnet is refused", () => {
  assert.throws(
    () =>
      assertSecondMintAllowed({
        ...ok,
        genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      }),
    /is not devnet/,
  );
});

test("the first demo mint cannot be reused as the second mint", () => {
  assert.throws(
    () => assertSecondMintAllowed({ ...ok, secondMint: PROTECTED_FIRST_MINT }),
    /different mint/,
  );
});

test("the mainnet SKR address is not accepted as the devnet mint", () => {
  assert.throws(
    () => assertSecondMintAllowed({ ...ok, secondMint: SKR_MINT }),
    /SKR mint/,
  );
});

test("the first mandate source cannot be the account that receives the new delegate", () => {
  assert.throws(
    () => assertSecondMintAllowed({ ...ok, secondSource: PROTECTED_FIRST_SOURCE }),
    /first mandate source/,
  );
});

test("the purpose stored for the second mandate does not name that mint SKR", () => {
  assert.equal(SECOND_PURPOSE.includes("SKR"), false);
  assert.equal(SECOND_PURPOSE.includes("skr"), false);
});

test("readTokenDelegate reports the classic delegate and a missing one as empty", () => {
  const present = Buffer.alloc(165);
  const delegate = Keypair.generate().publicKey;
  present.writeBigUInt64LE(1_000n, 64);
  present.writeUInt32LE(1, 72);
  Buffer.from(delegate.toBytes()).copy(present, 76);
  present.writeBigUInt64LE(300_000_000n, 121);
  const parsed = readTokenDelegate(present);
  assert.equal(parsed.delegate, delegate.toBase58());
  assert.equal(parsed.delegatedAmount, 300_000_000n);
  assert.equal(parsed.amount, 1_000n);

  const missing = Buffer.alloc(165);
  missing.writeBigUInt64LE(4n, 64);
  assert.equal(readTokenDelegate(missing).delegate, null);
  assert.equal(readTokenDelegate(missing).amount, 4n);
});
