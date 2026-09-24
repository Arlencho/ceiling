import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Connection, Keypair, type ConnectionConfig } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { MissingListedTransactionError, decisionsForMandate } from "./read.js";
import { TOKEN_PROGRAM, encodeBase58, framed, legacyChargeTx, paidLog, world } from "./testkit.js";

// Backend critic round 3 on PR 211. The default read opens its own Connection
// for the listing and every transaction read. These cases drive that path over
// HTTP with a real Connection, which the fake in testkit skips.
// H1 passes the header through connectionConfig and through readConnection.

type Rpc = { id: unknown; method: string; params: unknown[] };

async function serve(handle: (rpc: Rpc, req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
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
    keys: [w.agent.publicKey, w.mandate, ledger, w.source.publicKey, w.destination.publicKey, w.mint.publicKey, TOKEN_PROGRAM, PROGRAM_ID],
  });
  // web3's getTransaction parser wants the wire shape, which the fake in testkit skips.
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

const SIG_A = encodeBase58(Buffer.alloc(64, 3));
const SIG_B = encodeBase58(Buffer.alloc(64, 4));

async function assertCallerHeaders(via: "connectionConfig" | "readConnection"): Promise<void> {
  const w = world();
  const seenHeader: Array<string | undefined> = [];
  const rpc = await serve((body, req, res) => {
    seenHeader.push(req.headers["x-veto-critic"] as string | undefined);
    if (req.headers["x-veto-critic"] !== "r3") {
      json(res, 401, { jsonrpc: "2.0", id: body.id, error: { code: 401, message: "unauthorized" } });
      return;
    }
    if (body.method === "getSignaturesForAddress") {
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: [{ signature: SIG_A, slot: 20, err: null, memo: null, blockTime: 200 }] });
      return;
    }
    json(res, 200, { jsonrpc: "2.0", id: body.id, result: paidRpcTx(w, SIG_A, 1n) });
  });
  const httpHeaders: NonNullable<ConnectionConfig["httpHeaders"]> = { "x-veto-critic": "r3" };
  try {
    const caller = new Connection(rpc.url, "confirmed");
    const rows =
      via === "readConnection"
        ? await decisionsForMandate(caller, w.mandate, {
            sleep: async () => {},
            readConnection: new Connection(rpc.url, {
              commitment: "confirmed",
              httpHeaders,
              disableRetryOnRateLimit: true,
            }),
          })
        : await decisionsForMandate(caller, w.mandate, {
            sleep: async () => {},
            connectionConfig: { httpHeaders, commitment: "processed", disableRetryOnRateLimit: false },
          });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.nonce, 1n);
    assert.deepEqual(seenHeader, ["r3", "r3"]);
  } finally {
    await rpc.close();
  }
}

test("H1: a caller's httpHeaders reach the listing and the transaction reads via connectionConfig", async () => {
  await assertCallerHeaders("connectionConfig");
});

test("H1: a caller's httpHeaders reach the listing and the transaction reads via readConnection", async () => {
  await assertCallerHeaders("readConnection");
});

test("H2: a null getTransaction through the module's own connection surfaces as MissingListedTransactionError and is not retried", async () => {
  const w = world();
  const calls: string[] = [];
  const rpc = await serve((body, _req, res) => {
    calls.push(`${body.method}:${body.method === "getTransaction" ? String(body.params[0]).slice(0, 4) : ""}`);
    if (body.method === "getSignaturesForAddress") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: [
          { signature: SIG_A, slot: 20, err: null, memo: null, blockTime: 200 },
          { signature: SIG_B, slot: 10, err: null, memo: null, blockTime: 100 },
        ],
      });
      return;
    }
    if (body.params[0] === SIG_A) {
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: paidRpcTx(w, SIG_A, 2n) });
      return;
    }
    json(res, 200, { jsonrpc: "2.0", id: body.id, result: null });
  });
  const delays: number[] = [];
  try {
    const connection = new Connection(rpc.url, "confirmed");
    await assert.rejects(
      () =>
        decisionsForMandate(connection, w.mandate, {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof MissingListedTransactionError);
        assert.equal(err.signature, SIG_B);
        return true;
      },
    );
  } finally {
    await rpc.close();
  }
  // One listing, one read per signature, the null answer asked for exactly once.
  assert.deepEqual(calls, ["getSignaturesForAddress:", `getTransaction:${SIG_A.slice(0, 4)}`, `getTransaction:${SIG_B.slice(0, 4)}`]);
  // Only the two 1000 ms spacing waits: no backoff wait was spent on the null.
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(Keypair.generate().publicKey.equals(w.mandate), false);
});
