import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REASON_TEXT, reasonText } from "./reasons.js";

test("the bundled IDL matches indexer/idl/veto.json byte for byte", () => {
  const bundled = readFileSync(fileURLToPath(new URL("../idl/veto.json", import.meta.url)));
  const upstream = readFileSync(fileURLToPath(new URL("../../indexer/idl/veto.json", import.meta.url)));
  assert.equal(bundled.equals(upstream), true);
});

test("reason texts match app/lib/constants.ts", () => {
  const source = readFileSync(fileURLToPath(new URL("../../app/lib/constants.ts", import.meta.url)), "utf8");
  const fromApp = reasonTextsFromApp(source);
  const fromSdk: Record<number, string> = {};
  for (const [code, text] of Object.entries(REASON_TEXT)) {
    fromSdk[Number(code)] = text;
  }
  assert.deepEqual(fromSdk, fromApp);
  assert.match(source, /return REASON_TEXT\[reason\] \?\? 'unknown'/);
  assert.equal(reasonText(99), "unknown");
});

function reasonTextsFromApp(source: string): Record<number, string> {
  const codes = new Map<string, number>();
  for (const match of source.matchAll(/export const (REASON_[A-Z0-9_]+) = (\d+);/g)) {
    const name = match[1];
    const value = match[2];
    if (!name || !value) continue;
    codes.set(name, Number(value));
  }
  const block = /export const REASON_TEXT[\s\S]*?\n\};/.exec(source);
  if (!block) throw new Error("app/lib/constants.ts has no REASON_TEXT");
  const out: Record<number, string> = {};
  for (const match of block[0].matchAll(/\[(REASON_[A-Z0-9_]+)\]:\s*['"]([^'"]*)['"]/g)) {
    const name = match[1];
    const text = match[2];
    if (!name || text === undefined) continue;
    const code = codes.get(name);
    if (code === undefined) throw new Error(`app constants name ${name} without a number`);
    out[code] = text;
  }
  if (Object.keys(out).length === 0) throw new Error("parsed no reason texts from the app");
  return out;
}
