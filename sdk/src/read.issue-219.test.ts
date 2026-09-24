import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, Agent } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Connection, Keypair, type ConnectionConfig, type PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_SPACING_MS, decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, encodeBase58, framed, legacyChargeTx, paidLog, world } from "./testkit.js";

// Issue 219. web3.js does not expose a connection's config, so a custom header,
// fetch, middleware, or agent is passed as connectionConfig or as readConnection.
// With neither, the read keeps the PR 211 pacing on a fresh connection.

type Rpc = { id: unknown; method: string; params: unknown[] };
type Via = "connectionConfig" | "readConnection";

async function serve(
  handle: (rpc: Rpc, req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handle(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc, req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function paidRpcTx(w: ReturnType<typeof world>, signature: string, nonce: bigint) {
  const ledger = ledgerPda(PROGRAM_ID, w.mandate);
  const tx = legacyChargeTx({
    signature,
    slot: 20,
    blockTime: 200,
    logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, nonce, nonce, nonce)]),
    amount: nonce,
    nonce,
    keys: [
      w.agent.publicKey,
      w.mandate,
      ledger,
      w.source.publicKey,
      w.destination.publicKey,
      w.mint.publicKey,
      TOKEN_PROGRAM,
      PROGRAM_ID,
    ],
  });
  const transaction = tx.transaction;
  const keys = transaction?.message?.accountKeys ?? [];
  if (!transaction) throw new Error("legacyChargeTx returned no transaction");
  return {
    ...tx,
    meta: { ...tx.meta, fee: 5000, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1) },
    transaction: {
      ...transaction,
      message: {
        ...transaction.message,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        recentBlockhash: encodeBase58(Buffer.alloc(32, 9)),
      },
    },
  };
}

const SIG = encodeBase58(Buffer.alloc(64, 8));
const noSleep = async (): Promise<void> => {};

function decisions(url: string, mandate: PublicKey, via: Via, config: ConnectionConfig) {
  const caller = new Connection(url, "confirmed");
  if (via === "readConnection") {
    const readConnection = new Connection(url, {
      ...config,
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    });
    return decisionsForMandate(caller, mandate, { sleep: noSleep, readConnection });
  }
  return decisionsForMandate(caller, mandate, {
    sleep: noSleep,
    connectionConfig: {
      ...config,
      commitment: "processed",
      disableRetryOnRateLimit: false,
    },
  });
}

for (const via of ["connectionConfig", "readConnection"] as const) {
  test(`a custom header and a custom fetch reach every decision request via ${via}`, async () => {
    const w = world();
    const seen: string[] = [];
    let fetches = 0;
    const rpc = await serve((body, req, res) => {
      seen.push(String(req.headers["x-veto-read"] ?? ""));
      if (req.headers["x-veto-read"] !== "kept") {
        json(res, 401, { jsonrpc: "2.0", id: body.id, error: { code: 401, message: "unauthorized" } });
        return;
      }
      if (body.method === "getSignaturesForAddress") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: [{ signature: SIG, slot: 20, err: null, memo: null, blockTime: 200 }],
        });
        return;
      }
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: paidRpcTx(w, SIG, 4n) });
    });
    const fetch: NonNullable<ConnectionConfig["fetch"]> = async (input, init) => {
      fetches += 1;
      return globalThis.fetch(input, init);
    };
    try {
      const rows = await decisions(rpc.url, w.mandate, via, {
        httpHeaders: { "x-veto-read": "kept" },
        fetch,
        wsEndpoint: "ws://127.0.0.1:9",
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.nonce, 4n);
      assert.deepEqual(seen, ["kept", "kept"]);
      assert.equal(fetches, seen.length);
    } finally {
      await rpc.close();
    }
  });

  test(`a custom fetchMiddleware reaches every decision request via ${via}`, async () => {
    const w = world();
    const seen: string[] = [];
    const rpc = await serve((body, req, res) => {
      seen.push(String(req.headers["x-veto-mw"] ?? ""));
      if (req.headers["x-veto-mw"] !== "on") {
        json(res, 401, { jsonrpc: "2.0", id: body.id, error: { code: 401, message: "unauthorized" } });
        return;
      }
      if (body.method === "getSignaturesForAddress") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: [{ signature: SIG, slot: 20, err: null, memo: null, blockTime: 200 }],
        });
        return;
      }
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: paidRpcTx(w, SIG, 5n) });
    });
    const fetchMiddleware: NonNullable<ConnectionConfig["fetchMiddleware"]> = (info, init, next) => {
      const headers = new Headers(init?.headers);
      headers.set("x-veto-mw", "on");
      next(info, { ...init, headers });
    };
    try {
      const rows = await decisions(rpc.url, w.mandate, via, {
        fetchMiddleware,
        wsEndpoint: "ws://127.0.0.1:9",
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.nonce, 5n);
      assert.deepEqual(seen, ["on", "on"]);
    } finally {
      await rpc.close();
    }
  });

  test(`a custom http agent is the agent on every decision request via ${via}`, async () => {
    const w = world();
    const agent = new Agent();
    const seen: unknown[] = [];
    const rpc = await serve((body, _req, res) => {
      if (body.method === "getSignaturesForAddress") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: [{ signature: SIG, slot: 20, err: null, memo: null, blockTime: 200 }],
        });
        return;
      }
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: paidRpcTx(w, SIG, 6n) });
    });
    const fetch: NonNullable<ConnectionConfig["fetch"]> = async (input, init) => {
      seen.push((init as { agent?: unknown } | undefined)?.agent);
      return globalThis.fetch(input, init);
    };
    try {
      const rows = await decisions(rpc.url, w.mandate, via, { httpAgent: agent, fetch });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.nonce, 6n);
      assert.equal(seen.length, 2);
      assert.equal(seen[0], agent);
      assert.equal(seen[1], agent);
    } finally {
      agent.destroy();
      await rpc.close();
    }
  });
}

test("a caller passing neither readConnection nor connectionConfig still gets the PR 211 pacing", async () => {
  const calls: string[] = [];
  const seenHeader: string[] = [];
  let listingCommitment: unknown;
  const rpc = await serve((body, req, res) => {
    calls.push(body.method);
    seenHeader.push(String(req.headers["x-veto-caller"] ?? ""));
    if (body.method === "getSignaturesForAddress") {
      const config = body.params[1];
      listingCommitment =
        config && typeof config === "object" && "commitment" in config
          ? (config as { commitment?: unknown }).commitment
          : undefined;
      json(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: [{ signature: SIG, slot: 1, err: null, memo: null, blockTime: 1 }],
      });
      return;
    }
    json(res, 429, {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: 429, message: "Too many requests for a specific RPC call" },
    });
  });
  const delays: number[] = [];
  try {
    const connection = new Connection(rpc.url, {
      commitment: "confirmed",
      httpHeaders: { "x-veto-caller": "on-the-caller" },
    });
    await assert.rejects(
      () =>
        decisionsForMandate(connection, Keypair.generate().publicKey, {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }),
      /429/,
    );
  } finally {
    await rpc.close();
  }
  assert.equal(calls.length, 5, calls.join(","));
  assert.equal(calls[0], "getSignaturesForAddress");
  assert.deepEqual(calls.slice(1), ["getTransaction", "getTransaction", "getTransaction", "getTransaction"]);
  assert.equal(delays[0], DECISION_FETCH_SPACING_MS);
  assert.deepEqual(delays.slice(1), [
    DECISION_FETCH_BACKOFF_MS,
    DECISION_FETCH_BACKOFF_MS * 2,
    DECISION_FETCH_BACKOFF_MS * 4,
  ]);
  assert.equal(listingCommitment, "confirmed");
  assert.deepEqual(seenHeader, ["", "", "", "", ""]);
});
