import assert from "node:assert/strict";
import { test } from "node:test";
import { type Connection } from "@solana/web3.js";
import {
  confirmSignature,
  consumeConfirmAnswer,
  handleUnhandledRejection,
} from "./confirm.js";
import { RateLimitedError } from "./rpc.js";

function mockConnection(args: {
  wsDelayMs: number;
  status: "pending" | "confirmed" | "refuse";
  refuseDelayMs?: number;
}): Connection {
  return {
    onSignature(_sig: string, cb: (result: { err: null }, ctx: { slot: number }) => void) {
      setTimeout(() => cb({ err: null }, { slot: 1 }), args.wsDelayMs);
      return 1;
    },
    async getSignatureStatus() {
      if (args.status === "refuse") {
        if (args.refuseDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, args.refuseDelayMs));
        }
        throw new RateLimitedError("rpc rate limited on http://127.0.0.1:1");
      }
      if (args.status === "confirmed") {
        return {
          context: { slot: 1 },
          value: { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" },
        };
      }
      return { context: { slot: 1 }, value: null };
    },
    async removeSignatureListener() {},
  } as unknown as Connection;
}

test("a pending status poll then a late websocket confirm is a confirmation, not a rate limit", async () => {
  const lines: string[] = [];
  await confirmSignature(mockConnection({ wsDelayMs: 600, status: "pending" }), "slow-sig", {
    graceMs: 100,
    log: (line) => lines.push(line),
  });
  assert.equal(
    lines.some((line) => /rate limit/i.test(line) || /poll failed/i.test(line)),
    false,
    `invented a throttle: ${lines.join(" | ")}`,
  );
});

test("a leftover rate-limit after websocket confirm is logged and does not fail the confirm", async () => {
  const lines: string[] = [];
  await confirmSignature(mockConnection({ wsDelayMs: 20, status: "refuse" }), "sig-1", {
    graceMs: 500,
    log: (line) => lines.push(line),
  });
  assert.ok(
    lines.some((line) => /leftover status poll after sig-1 was already confirmed/.test(line)),
    `logged: ${lines.join(" | ")}`,
  );
});

test("a status poll that refuses to answer fails with that refusal when the websocket never confirms", async () => {
  const err = new RateLimitedError("rpc rate limited on http://127.0.0.1:1");
  const connection = {
    onSignature() {
      return 1;
    },
    async getSignatureStatus() {
      throw err;
    },
    async removeSignatureListener() {},
  } as unknown as Connection;
  await assert.rejects(
    () => confirmSignature(connection, "sig", { graceMs: 20, log: () => {} }),
    (caught: unknown) => caught === err,
  );
});

test("a clean confirm leaves no leftover answer for a process handler to consume", async () => {
  await confirmSignature(mockConnection({ wsDelayMs: 10, status: "confirmed" }), "clean-sig", {
    log: () => {},
  });
  assert.equal(consumeConfirmAnswer(), false);
});

test("an unhandled rejection is fatal even after a confirm that already answered", () => {
  const lines: string[] = [];
  const disposition = handleUnhandledRejection(new RateLimitedError("rpc rate limited on http://127.0.0.1:1"), {
    confirmAlreadyAnswered: true,
    log: (line) => lines.push(line),
  });
  assert.equal(disposition, "fatal");
  assert.ok(lines.some((line) => line.includes("unhandled rejection: rpc rate limited on http://127.0.0.1:1")));
});

test("an unhandled rejection that is not a leftover confirm poll is fatal", () => {
  const lines: string[] = [];
  const disposition = handleUnhandledRejection(new Error("socket hang up"), {
    confirmAlreadyAnswered: true,
    log: (line) => lines.push(line),
  });
  assert.equal(disposition, "fatal");
  assert.ok(lines.some((line) => line.includes("unhandled rejection: socket hang up")), `logged: ${lines.join(" | ")}`);
});

test("a rate-limit with no confirm answer is fatal", () => {
  const lines: string[] = [];
  const disposition = handleUnhandledRejection(new RateLimitedError("rpc rate limited on http://127.0.0.1:1"), {
    confirmAlreadyAnswered: false,
    log: (line) => lines.push(line),
  });
  assert.equal(disposition, "fatal");
  assert.ok(lines.some((line) => line.includes("unhandled rejection: rpc rate limited on http://127.0.0.1:1")));
});
