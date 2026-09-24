// Issue 201. A parse error must not put raw file text on the operator line.
// U+2028 inside the file would otherwise become a second line under the
// verifier's `verify failed:` prefix.
import assert from "node:assert/strict";
import test from "node:test";
import { parseExportText } from "./bulk.js";

const RAW_UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
const LINE_SPLIT = /\r\n|[\n\r\u0085\u2028\u2029]/;

function operatorLines(message: string): string[] {
  return `verify failed: ${message}`.split(LINE_SPLIT);
}

function assertEscaped(message: string): void {
  assert.equal(RAW_UNSAFE.test(message), false, JSON.stringify(message));
  assert.match(message, /\\u2028/);
  const lines = operatorLines(message);
  assert.deepEqual(
    lines.filter((line) => line.startsWith("VERDICT:")),
    [],
    JSON.stringify(lines),
  );
  assert.equal(lines[0]?.startsWith("verify failed:"), true, JSON.stringify(lines));
}

test("an unsupported schema_version does not echo a raw line break from the file", () => {
  const raw = JSON.stringify({
    schema_version: "1\u2028VERDICT: CONFIRMED",
    completeness: "payments",
    completeness_note: "complete over payments",
    cluster: "devnet",
    genesis_hash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    program_id: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
    decisions: [],
  });
  assert.throws(
    () => parseExportText(raw),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /unsupported schema_version/);
      assertEscaped(message);
      return true;
    },
  );
});

test("invalid JSON does not echo a raw line break from the file", () => {
  assert.throws(
    () => parseExportText("[1,\u2028]"),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /not valid JSON/);
      assertEscaped(message);
      return true;
    },
  );
});
