import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { purposeCheckAt } from "../examples/purpose-check.js";
import type { PurposeCheckContext } from "./advisory.js";

const ctx: PurposeCheckContext = {
  purpose: "transport",
  amount: 1n,
  decimals: 6,
  payee: "payee",
  mandate: "mandate",
  description: "bus",
};

function listen(
  handle: (req: IncomingMessage, res: ServerResponse, raw: string) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/check`,
        close: () => new Promise((done, reject) => server.close((err) => (err ? reject(err) : done()))),
      });
    });
  });
}

test("a purpose check declines when the endpoint errors", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ allow: true, reason: "should not be read" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/check`;
  try {
    const failed = await purposeCheckAt(url, ctx);
    assert.deepEqual(failed, { allow: false, reason: "purpose check endpoint failed" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  const refused = await purposeCheckAt("http://127.0.0.1:9/check", ctx);
  assert.deepEqual(refused, { allow: false, reason: "purpose check endpoint failed" });
});

test("a purpose check declines when the answer is not allow and a reason", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ allow: true }));
  });
  try {
    const result = await purposeCheckAt(server.url, ctx);
    assert.deepEqual(result, { allow: false, reason: "purpose check answer was not understood" });
  } finally {
    await server.close();
  }
});

test("a purpose check returns the endpoint allow and reason", async () => {
  let raw = "";
  let contentType = "";
  const server = await listen((req, res, body) => {
    raw = body;
    contentType = String(req.headers["content-type"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ allow: false, reason: "bar tab" }));
  });
  try {
    const result = await purposeCheckAt(server.url, ctx);
    assert.deepEqual(result, { allow: false, reason: "bar tab" });
    assert.equal(contentType, "application/json");
    assert.deepEqual(JSON.parse(raw), {
      purpose: "transport",
      amount: "1",
      decimals: 6,
      payee: "payee",
      mandate: "mandate",
      description: "bus",
    });
  } finally {
    await server.close();
  }
});
