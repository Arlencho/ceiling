import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Connection, Keypair, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import {
  DECISION_FETCH_BACKOFF_CAP_MS,
  DECISION_FETCH_BACKOFF_MS,
  DECISION_FETCH_CONCURRENCY,
  DECISION_FETCH_SPACING_MS,
  decisionFetchBackoffMs,
  decisionsForMandate,
} from "./read.js";
import { TOKEN_PROGRAM, encodeBase58, framed, legacyChargeTx, paidLog, world, type FakeConnection } from "./testkit.js";

function putPaid(fake: FakeConnection, w: ReturnType<typeof world>, signature: string, nonce: bigint): void {
  fake.transactions.set(
    signature,
    legacyChargeTx({
      signature,
      slot: Number(nonce),
      blockTime: Number(nonce) * 10,
      logs: framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, nonce, nonce, nonce)]),
      amount: nonce,
      nonce,
      keys: [
        w.agent.publicKey,
        w.mandate,
        ledgerPda(PROGRAM_ID, w.mandate),
        w.source.publicKey,
        w.destination.publicKey,
        w.mint.publicKey,
        TOKEN_PROGRAM,
        PROGRAM_ID,
      ],
    }),
  );
}

function listed(signature: string, slot: number): ConfirmedSignatureInfo {
  return { signature, slot, err: null, memo: null, blockTime: slot * 10, confirmationStatus: "confirmed" };
}

test("the default read keeps one transaction fetch in flight, and concurrency can raise it", async () => {
  const w = world();
  const count = 6;
  const signatures: ConfirmedSignatureInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    const signature = `s${i}`;
    putPaid(w.fake, w, signature, BigInt(count - i));
    signatures.push(listed(signature, count - i));
  }
  w.fake.signatures = signatures;
  let inFlight = 0;
  let maxInFlight = 0;
  const real = w.fake.getTransaction.bind(w.fake);
  w.fake.getTransaction = async (signature: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    try {
      return await real(signature);
    } finally {
      inFlight -= 1;
    }
  };

  const paced = await decisionsForMandate(w.connection, w.mandate, { pageSize: count });
  assert.equal(paced.length, count);
  assert.equal(DECISION_FETCH_CONCURRENCY, 1);
  assert.equal(maxInFlight, 1);

  maxInFlight = 0;
  const raised = await decisionsForMandate(w.connection, w.mandate, { pageSize: count, concurrency: 3 });
  assert.equal(raised.length, count);
  assert.equal(maxInFlight, 3);
});

test("a 429 on getTransaction is retried with backoff and then returns the decision", async () => {
  const w = world();
  putPaid(w.fake, w, "paid", 1n);
  w.fake.signatures = [listed("paid", 10)];
  let calls = 0;
  const delays: number[] = [];
  const real = w.fake.getTransaction.bind(w.fake);
  w.fake.getTransaction = async (signature: string) => {
    calls += 1;
    if (calls < 3) {
      throw new Error('429 : {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}}');
    }
    return real(signature);
  };
  const rows = await decisionsForMandate(w.connection, w.mandate, {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(rows[0]?.signature, "paid");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_BACKOFF_MS * 2]);
});

test("a 429 that keeps coming is raised after the retry budget", async () => {
  const w = world();
  w.fake.signatures = [listed("paid", 10)];
  let calls = 0;
  const delays: number[] = [];
  w.fake.getTransaction = async () => {
    calls += 1;
    throw new Error("429 Too many requests");
  };
  await assert.rejects(
    () =>
      decisionsForMandate(w.connection, w.mandate, {
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    /429 Too many requests/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_BACKOFF_MS * 2, DECISION_FETCH_BACKOFF_MS * 4]);
});

test("an error that is not a 429 is not retried", async () => {
  const w = world();
  w.fake.signatures = [listed("paid", 10)];
  let calls = 0;
  w.fake.getTransaction = async () => {
    calls += 1;
    throw new Error("node down");
  };
  await assert.rejects(() => decisionsForMandate(w.connection, w.mandate, { sleep: async () => {} }), /node down/);
  assert.equal(calls, 1);
});

test("a 429 on the signature listing is retried and then the decision is returned", async () => {
  const w = world();
  putPaid(w.fake, w, "paid", 1n);
  w.fake.signatures = [listed("paid", 10)];
  let calls = 0;
  const delays: number[] = [];
  const real = w.fake.getSignaturesForAddress.bind(w.fake);
  w.fake.getSignaturesForAddress = async (address, config) => {
    calls += 1;
    if (calls < 3) throw new Error("429 Too many requests");
    return real(address, config);
  };
  const rows = await decisionsForMandate(w.connection, w.mandate, {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(rows[0]?.signature, "paid");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_BACKOFF_MS * 2]);
});

test("concurrency must be a positive integer within one page", async () => {
  const w = world();
  await assert.rejects(
    () => decisionsForMandate(w.connection, w.mandate, { concurrency: 0 }),
    /concurrency must be an integer from 1 to 1000/,
  );
});

test("a 429 is retried by the SDK and the web3 client does not retry it too", { timeout: 90_000 }, async () => {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method?: string };
      calls.push(body.method ?? "unknown");
      if (body.method === "getSignaturesForAddress") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            result: [
              {
                signature: encodeBase58(Buffer.alloc(64, 7)),
                slot: 1,
                err: null,
                memo: null,
                blockTime: 1,
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? 1,
          error: { code: 429, message: "Too many requests for a specific RPC call" },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const delays: number[] = [];
  try {
    const connection = new Connection(`http://127.0.0.1:${address.port}`, "confirmed");
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
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  assert.equal(DECISION_FETCH_SPACING_MS, 1000);
  assert.equal(calls.length, 5, `HTTP calls: ${calls.join(",")}`);
  assert.deepEqual(calls.slice(1), ["getTransaction", "getTransaction", "getTransaction", "getTransaction"]);
  assert.equal(delays[0], DECISION_FETCH_SPACING_MS);
  assert.deepEqual(delays.slice(1), [DECISION_FETCH_BACKOFF_MS, DECISION_FETCH_BACKOFF_MS * 2, DECISION_FETCH_BACKOFF_MS * 4]);
});

test("429 backoff doubles until the cap, and jitter stays inside that ceiling", () => {
  assert.equal(DECISION_FETCH_BACKOFF_MS, 200);
  assert.equal(DECISION_FETCH_BACKOFF_CAP_MS, 2000);
  assert.equal(decisionFetchBackoffMs(0), 200);
  assert.equal(decisionFetchBackoffMs(1), 400);
  assert.equal(decisionFetchBackoffMs(2), 800);
  assert.equal(decisionFetchBackoffMs(10), 2000);
  assert.equal(decisionFetchBackoffMs(0, () => 0), 100);
  assert.equal(decisionFetchBackoffMs(0, () => 1), 200);
  assert.equal(decisionFetchBackoffMs(2, () => 0), 400);
  assert.equal(decisionFetchBackoffMs(10, () => 0), 1000);
  assert.equal(decisionFetchBackoffMs(10, () => 1), 2000);
});
