// Security critic, PR 121 round 1. The indexer keeps its own copy of the
// redaction helper (tools/lib.ts re-exports this one, so verify.ts and
// produce.ts print through it). A key in the URL path is kept. RED on the
// branch head.
import assert from "node:assert/strict";
import test from "node:test";
import { redactRpcUrl, redactRpcUrls } from "./rpc.js";

test("critic sec r1: indexer redactRpcUrl drops a key carried in the path", () => {
  const raw = "https://solana-devnet.g.alchemy.com/v2/SECRET123";
  const shown = redactRpcUrl(raw);
  assert.equal(shown, "https://solana-devnet.g.alchemy.com", shown);
  assert.equal(shown.includes("SECRET123"), false, shown);
  assert.equal(redactRpcUrl("http://[::1]:8899/secret"), "http://[::1]:8899");
  const list = redactRpcUrls([raw, "https://cool-name.solana-devnet.quiknode.pro/SECRET123/"]);
  assert.equal(list.includes("SECRET123"), false, list);
});
