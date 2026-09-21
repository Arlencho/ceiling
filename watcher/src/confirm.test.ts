import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUnhandledRejection } from "./confirm.js";
import { RateLimitedError } from "./rpc.js";

test("a leftover rate-limit after confirm is reported and is not fatal", () => {
  const lines: string[] = [];
  const disposition = handleUnhandledRejection(new RateLimitedError("rpc rate limited on http://127.0.0.1:1"), {
    confirmAlreadyAnswered: true,
    log: (line) => lines.push(line),
  });
  assert.equal(disposition, "discarded");
  assert.ok(
    lines.some((line) =>
      /unhandled rejection after confirm no longer needed this answer: rpc rate limited on http:\/\/127\.0\.0\.1:1/.test(
        line,
      ),
    ),
    `logged: ${lines.join(" | ")}`,
  );
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

test("a rate-limit before confirm has an answer is fatal", () => {
  const lines: string[] = [];
  const disposition = handleUnhandledRejection(new RateLimitedError("rpc rate limited on http://127.0.0.1:1"), {
    confirmAlreadyAnswered: false,
    log: (line) => lines.push(line),
  });
  assert.equal(disposition, "fatal");
  assert.ok(lines.some((line) => line.includes("unhandled rejection: rpc rate limited on http://127.0.0.1:1")));
});

