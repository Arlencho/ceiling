import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotAccount } from "./snapshot-account.js";

const address = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
const owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
function rpc(value: unknown, hash = genesis): typeof fetch {
  return (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.jsonrpc, "2.0");
    if (request.method === "getAccountInfo") {
      assert.deepEqual(request.params, [address, { encoding: "base64", commitment: "finalized" }]);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
      result: request.method === "getGenesisHash" ? hash : { context: { slot: 123 }, value } }));
  }) as typeof fetch;
}

test("snapshot JSON preserves account bytes, owner, balance and contextual slot", async () => {
  const result = await snapshotAccount(address, "https://example.invalid", rpc({
    owner, lamports: 1461600, data: ["AAECA/8=", "base64"],
  }));
  const { fetched_at, ...account } = JSON.parse(JSON.stringify(result));
  assert.deepEqual(account, { address, owner, lamports: 1461600, data_base64: "AAECA/8=", slot: 123 });
  assert.equal(new Date(fetched_at).toISOString(), fetched_at);
  assert.deepEqual([...Buffer.from(account.data_base64, "base64")], [0, 1, 2, 3, 255]);
});

test("missing accounts cannot produce a snapshot", async () => {
  await assert.rejects(snapshotAccount(address, "https://example.invalid", rpc(null)), /account not found/);
});

test("a non-mainnet endpoint cannot produce a mainnet snapshot", async () => {
  await assert.rejects(snapshotAccount(address, "https://example.invalid", rpc(null, "devnet")), /not mainnet/);
});

test("transport and RPC errors never expose endpoint credentials", async () => {
  const secret = "https://example.invalid/private-key?api-key=secret";
  for (const fetcher of [
    (async () => { throw new Error(secret); }) as typeof fetch,
    (async () => new Response(JSON.stringify({ error: { message: secret } }))) as typeof fetch,
  ]) {
    await assert.rejects(snapshotAccount(address, secret, fetcher), (error: Error) => {
      assert.equal(error.message, "snapshot-account: RPC request failed");
      assert.ok(!error.stack?.includes(secret));
      return true;
    });
  }
});
