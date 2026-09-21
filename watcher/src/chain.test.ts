import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { mandatePda, recoverSettledCharge, u64Le } from "./chain.js";
import { loadConfig } from "./config.js";

// Every chain identity is required now: the loader stopped inventing an
// endpoint, a program or an account when nothing is configured. These tests
// were written while those defaults still existed, so they name them here.
// Nothing about what they assert has changed.
const IDENTITIES = {
  VETO_PROGRAM_ID: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  VETO_MINT: "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU",
  VETO_OWNER: "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc",
  VETO_OWNER_TOKEN: "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE",
  VETO_MERCHANT: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  VETO_MERCHANT_TOKEN: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  VETO_AGENT: "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w",
};

// Critic fixture, round 3. Confirms N4 on 4867104 by execution: the history
// walk asks for the mandate's signatures, never the program's, and still
// recovers the paid charge. Goes RED on e03cbc3, where the walk asked for the
// program and this server answers that with an empty page.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: unknown[] };

function startRpc(handler: (req: RpcRequest) => unknown): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
        const reply = (r: RpcRequest) => {
          try {
            return { jsonrpc: "2.0", id: r.id, result: handler(r) };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message } };
          }
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const CHARGE_DISCRIMINATOR = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);

test("critic r3: history recovery walks the mandate's signatures, not the program's, and still finds the paid charge", async () => {
  const nonce = 1789855200n;
  const amount = 446_000n;
  const paidSig = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
  const agent = Keypair.generate();
  const asked: string[] = [];
  let mandate: PublicKey | undefined;
  let programId: PublicKey | undefined;

  const rpc = await startRpc((req) => {
    switch (req.method) {
      case "getAccountInfo":
        // The ledger ring has rolled past this window: nothing to recover there.
        return { context: { slot: 1 }, value: null };
      case "getSignaturesForAddress": {
        const address = String(req.params[0]);
        asked.push(address);
        if (mandate === undefined || address !== mandate.toBase58()) return [];
        return [{ signature: paidSig, slot: 1, err: null, memo: null, blockTime: 1 }];
      }
      case "getTransaction": {
        if (mandate === undefined || programId === undefined) throw new Error("not ready");
        const data = Buffer.concat([CHARGE_DISCRIMINATOR, u64Le(amount), u64Le(nonce)]);
        return {
          slot: 1,
          blockTime: 1,
          transaction: {
            signatures: [paidSig],
            message: {
              header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
              accountKeys: [agent.publicKey.toBase58(), mandate.toBase58(), programId.toBase58()],
              recentBlockhash: base58(new Uint8Array(32).fill(7)),
              instructions: [{ programIdIndex: 2, accounts: [0, 1], data: base58(data) }],
            },
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [0, 0, 0],
            postBalances: [0, 0, 0],
            innerInstructions: [],
            logMessages: ["Program log: VETO PAID amount=446000"],
            preTokenBalances: [],
            postTokenBalances: [],
            loadedAddresses: { writable: [], readonly: [] },
            computeUnitsConsumed: 0,
          },
        };
      }
      default:
        throw new Error(`unexpected rpc method ${req.method}`);
    }
  });

  try {
    const cfg = loadConfig({
      ...IDENTITIES,
      VETO_RPC: rpc.url,
      VETO_KEYS_DIR: mkdtempSync(join(tmpdir(), "veto-critic-r3-keys-")),
      VETO_MANDATE_ID: "1",
    });
    programId = new PublicKey(cfg.programId);
    mandate = mandatePda(programId, new PublicKey(cfg.owner), cfg.mandateId);

    const recovered = await recoverSettledCharge({ cfg, agent, nonce });

    assert.ok(recovered, "the paid charge must be recovered from history");
    assert.equal(recovered.decision, "paid");
    assert.equal(recovered.signature, paidSig);
    assert.equal(recovered.amount, amount);
    assert.ok(asked.length >= 1, "history must have been walked");
    for (const address of asked) {
      assert.equal(address, mandate.toBase58(), `the walk asked for ${address}, not the mandate`);
    }
    assert.equal(asked.includes(programId.toBase58()), false, "the walk must never page the whole program");
  } finally {
    await rpc.close();
  }
});
