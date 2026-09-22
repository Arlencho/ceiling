// Security critic, PR 121 round 1. Issue 120 asked for scheme and host only.
// The helper keeps the path, and the two most common paid Solana endpoints
// carry the key in the path, not the query. Both the startup line
// (index.ts, same helper) and the rate-limit line (makeFailoverFetch) print
// it. RED on the branch head.
import assert from "node:assert/strict";
import test from "node:test";
import { makeFailoverFetch, redactRpcUrl, redactRpcUrlsInText } from "./rpc.js";

const PATH_KEYED = [
  "https://solana-devnet.g.alchemy.com/v2/SECRET123",
  "https://cool-name.solana-devnet.quiknode.pro/SECRET123/",
  "https://rpc.ankr.com/solana_devnet/SECRET123",
];

test("critic sec r1: a key in the URL path is redacted by the helper", () => {
  const wrong: string[] = [];
  for (const raw of PATH_KEYED) {
    const shown = redactRpcUrl(raw);
    if (shown.includes("SECRET123")) wrong.push(`${raw} -> ${shown}`);
    const inText = redactRpcUrlsInText(`rpc rate limited: fetch failed on ${raw}.`);
    if (inText.includes("SECRET123")) wrong.push(`in text: ${inText}`);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

test("critic sec r1: the rate-limit log line drops a key carried in the path", async () => {
  const lines: string[] = [];
  const failover = makeFailoverFetch(PATH_KEYED, (line) => lines.push(line), {
    fetch: async () => new Response("no", { status: 429 }),
    sleep: async () => {},
    initialDelayMs: 0,
    maxPasses: 1,
  });
  let thrown = "";
  try {
    await failover(PATH_KEYED[0]!, { method: "POST" });
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  assert.ok(lines.length > 0, "no rate-limit line logged");
  const leaked = [...lines, thrown].filter((line) => line.includes("SECRET123"));
  assert.deepEqual(leaked, [], leaked.join("\n"));
});
