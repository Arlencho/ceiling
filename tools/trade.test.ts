import { test } from "node:test";
import assert from "node:assert/strict";
import { tradeFixture } from "../indexer/fixtures/trade.js";
import { decisionFromSignature } from "./export.js";
import { assessRecord } from "./verify.js";
import { parseRecord } from "./lib.js";
for (const refused of [false, true]) {
  test(`exports and verifies a ${refused ? "refused" : "filled"} trade and rejects changed amounts`, async () => {
    const f = tradeFixture(refused);
    const record: any = await decisionFromSignature(
      f.conn,
      f.signature,
      f.program,
      "localnet",
      "fixture-genesis",
    );
    assert.equal(record.kind, refused ? "refused" : "traded");
    assert.equal(record.rule, String(f.rule));
    assert.equal(record.mandate, undefined);
    assert.equal(record.amount_in, 100n);
    assert.equal(record.amount_out, refused ? 0n : 150n);
    assert.throws(() => parseRecord(record));
    const verdict = await assessRecord(record, "http://fixture", f.conn, {
      programId: f.program,
    });
    assert.equal(verdict.ok, true, verdict.text);
    assert.match(
      verdict.text,
      /Trade rule limits, ledger entry, and trade transaction agree\./,
    );
    for (const field of [
      "amount_in",
      "amount_out",
      "min_out",
      "nonce",
      "timestamp",
      "suggested_override",
    ]) {
      const bad = await assessRecord(
        { ...record, [field]: record[field] + 10n },
        "http://fixture",
        f.conn,
        { programId: f.program },
      );
      assert.equal(bad.ok, false, field);
      assert.match(bad.text, new RegExp(field));
    }
    const badLimit = await assessRecord(
      { ...record, limits: { ...record.limits, cap: 2n } },
      "http://fixture",
      f.conn,
      { programId: f.program },
    );
    assert.equal(badLimit.ok, false);
    assert.match(badLimit.text, /limits.cap/);
  });
}

test("trade JSON preserves integers above Number.MAX_SAFE_INTEGER", async () => {
  const { tradeRecordToJson, parseTradeRecord } = await import("./trade.js");
  const f = tradeFixture();
  const record = await decisionFromSignature(
    f.conn,
    f.signature,
    f.program,
    "localnet",
    "fixture-genesis",
  );
  assert.ok("rule" in record);
  const large = { ...record, amount_in: (1n << 64n) - 1n };
  assert.equal(
    parseTradeRecord(JSON.parse(tradeRecordToJson(large))).amount_in,
    large.amount_in,
  );
  assert.throws(
    () => parseTradeRecord({ ...record, amount_in: Number(large.amount_in) }),
    /amount_in/,
  );
});

for (const change of [
  "owner",
  "ledger rule",
  "event amount_out",
  "failed transaction",
  "foreign logs",
  "missing ledger",
] as const) {
  test(`a trade with ${change} cannot confirm`, async () => {
    const f = tradeFixture();
    const record = await decisionFromSignature(
      f.conn,
      f.signature,
      f.program,
      "localnet",
      "fixture-genesis",
    );
    const getAccountInfo = f.conn.getAccountInfo.bind(f.conn);
    if (change === "owner" || change === "missing ledger") {
      f.conn.getAccountInfo = (async (address: any) => {
        const info = await getAccountInfo(address);
        if (change === "missing ledger" && address.equals(f.ledger))
          return null;
        return info && change === "owner" ? { ...info, owner: f.pool } : info;
      }) as typeof f.conn.getAccountInfo;
    }
    if (change === "ledger rule") f.pool.toBuffer().copy(f.ledgerData, 8);
    if (change === "event amount_out") {
      f.event.writeBigUInt64LE(151n, 48);
      f.tx.meta.logMessages[1] = `Program data: ${f.event.toString("base64")}`;
    }
    if (change === "failed transaction")
      (f.tx.meta as { err: unknown }).err = { InstructionError: [0, "failed"] };
    if (change === "foreign logs")
      f.tx.meta.logMessages = f.tx.meta.logMessages.map((line) =>
        line.replace(String(f.program), String(f.pool)),
      );
    const result = await assessRecord(record, "http://fixture", f.conn, {
      programId: f.program,
    });
    assert.equal(result.code, 1, result.text);
  });
}

test("trade ledger decoding retains the live ring in oldest-first order", async () => {
  const { decodeTradeLedger, decodeTradeRule } = await import("./lib.js");
  const f = tradeFixture();
  f.ledgerData.writeUInt32LE(33, 40);
  for (let slot = 0; slot < 32; slot++)
    f.ledgerData.writeBigUInt64LE(
      BigInt(slot === 0 ? 33 : slot + 1),
      48 + slot * 88 + 64,
    );
  const ledger = decodeTradeLedger(f.ledgerData);
  assert.deepEqual(
    ledger.entries.map((entry) => entry.nonce),
    Array.from({ length: 32 }, (_, i) => BigInt(i + 2)),
  );
  assert.throws(() => decodeTradeLedger(f.ledgerData.subarray(0, -1)), /bytes/);
  assert.throws(() => decodeTradeRule(f.ruleData.subarray(0, 20)), /overruns/);
});

for (const refused of [false, true]) {
  test(`CLI exports by signature and rule, then verifies a ${refused ? "refused" : "filled"} trade`, async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { PublicKey } = await import("@solana/web3.js");
    const f = tradeFixture(refused);
    const encode58 = (data: Buffer) => {
      const alphabet =
        "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let n = BigInt(`0x${data.toString("hex")}`),
        text = "";
      while (n) {
        text = alphabet[Number(n % 58n)] + text;
        n /= 58n;
      }
      for (const byte of data) {
        if (byte !== 0) break;
        text = "1" + text;
      }
      return text;
    };
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (request.method === "getGenesisHash") result = "fixture-genesis";
      else if (request.method === "getSignaturesForAddress")
        result = await f.conn.getSignaturesForAddress(
          new PublicKey(request.params[0]),
          request.params[1],
        );
      else if (request.method === "getAccountInfo") {
        const account = await f.conn.getAccountInfo(
          new PublicKey(request.params[0]),
        );
        result = {
          context: { slot: 1 },
          value: account
            ? {
                data: [account.data.toString("base64"), "base64"],
                executable: false,
                lamports: 1000000,
                owner: String(account.owner),
                rentEpoch: 0,
              }
            : null,
        };
      } else if (request.method === "getTransaction") {
        const message = f.tx.transaction.message;
        result = {
          slot: 1,
          blockTime: 1000,
          version: 0,
          meta: {
            ...f.tx.meta,
            fee: 5000,
            preBalances: [],
            postBalances: [],
            loadedAddresses: { writable: [], readonly: [] },
            innerInstructions: [],
          },
          transaction: {
            signatures: [f.signature],
            message: {
              accountKeys: message.staticAccountKeys.map(String),
              recentBlockhash: String(f.pool),
              header: {
                numRequiredSignatures: 1,
                numReadonlySignedAccounts: 0,
                numReadonlyUnsignedAccounts: 1,
              },
              addressTableLookups: [],
              instructions: message.compiledInstructions.map((ix) => ({
                programIdIndex: ix.programIdIndex,
                accounts: ix.accountKeyIndexes,
                data: encode58(ix.data),
              })),
            },
          },
        };
      } else throw new Error(`unexpected fixture RPC method ${request.method}`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const dir = await mkdtemp(join(tmpdir(), "veto-trade-test-"));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      VETO_RPC: `http://127.0.0.1:${address.port}`,
      VETO_PROGRAM_ID: String(f.program),
      VETO_CLUSTER: "localnet",
    };
    const run = (script: string, args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(
            new URL("./node_modules/tsx/dist/cli.mjs", import.meta.url),
          ),
          fileURLToPath(new URL(script, import.meta.url)),
          ...args,
        ],
        { env, timeout: 15000 },
      );
    try {
      const bySig = await run("./export.ts", ["--signature", f.signature]);
      const byRule = await run("./export.ts", ["--rule", String(f.rule)]);
      assert.deepEqual(JSON.parse(bySig.stdout), JSON.parse(byRule.stdout));
      const path = join(dir, "record.json");
      await writeFile(path, bySig.stdout);
      const checked = await run("./verify.ts", [path]);
      assert.match(checked.stdout, /VERDICT: CONFIRMED/);
      for (const field of ["amount_in", "amount_out"]) {
        const changed = JSON.parse(bySig.stdout);
        changed[field] += 1;
        await writeFile(path, JSON.stringify(changed));
        await assert.rejects(run("./verify.ts", [path]), (err: any) => {
          assert.equal(err.code, 1);
          assert.match(err.stdout, /VERDICT: REJECTED/);
          assert.match(err.stdout, new RegExp(field));
          return true;
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
}


test("trade rule decoding preserves all 25 buckets and the fields after them", async () => {
  const { decodeTradeRule } = await import("./lib.js");
  const f = tradeFixture();
  const rule = decodeTradeRule(f.ruleData);
  assert.deepEqual(rule.dailyBuckets, Array.from({ length: 25 }, (_, i) => ({
    hour: BigInt(i), amount: i === 0 ? 100n : 0n,
  })));
  assert.equal(rule.floorNum, 1n);
  assert.equal(rule.expiresAt, 2000n);
  assert.equal(rule.lastNonce, 3n);
  assert.equal(rule.purpose, "test");
  assert.equal(rule.bump, 255);
});
