# Plan: the mechanism, and the eighteen days

Written against [AUDIT.md](AUDIT.md) on branch `assess/invariant`, tree at `6c57c3b`, on 2026-09-21.
Submissions close **2026-10-09 at 08:59 GMT+2** (`docs/PLAN.md:3`). That is eighteen days.

Two questions, answered with what the tree actually contains.

---

# Part one: the mechanism

## 1.1 What the audit constrains

Four numbers from AUDIT.md decide the shape of the fix, and three of them rule out the obvious
answer.

**42 of 66 are mechanical, and they are four different shapes, not one.** The audit's own table
splits them: 12 defaulted chain identities, 13 swallowed reads, 6 labels written from an input, 4
identities guessed from a substring, 3 local copies trusted over the source, 3 checks that do not
run, 1 wrong constant. A single rule reaches at most 12 of 42.

**A regex over `??` is the wrong instrument, and this is measurable.** The tracked non-test
TypeScript holds 52 sites matching `?? "literal"`:

```
$ git ls-files | grep -E '\.(ts|tsx)$' | grep -v '\.test\.' | xargs grep -nE '\?\?\s*["'"'"']' | wc -l
52
```

Twelve are the defect. The rest are argument parsing (`indexer/src/cli.ts:30-31`), CSV field
formatting (`app/lib/exportRecord.ts:264-266`) and a month name lookup (`app/lib/format.ts:146`). A
ban would need about forty exemptions, and it would still miss the two instances the task names as
live, because `indexer/src/cli.ts:21` reads `process.env.VETO_RPC ?? DEFAULT_RPC`: a named constant,
not a literal. The same holds for `catch`: there are 43 catch blocks in the non-test TypeScript and
13 of them are the defect.

So the mechanism is a **type** at the boundary, not a pattern over the body. A type fires exactly
where the boundary is and nowhere else, and it produces a compile error rather than a warning.

**The prototype already exists, twice, in this repo.** `FeedRead` / `FeedStatus` on
`feat/merchant-terminal` (`watcher/src/feed.ts:14-26`) is this type for one boundary.
`app/lib/mandateRead.ts` is this type for one read, and AUDIT.md's "Looked at and not counted"
section names it as the reason several app screens are clean. The mechanism is not an invention. It
is those two, generalised, put where every package can reach them, and pinned by a test.

## 1.2 M1: one discriminated outcome for every input boundary

New file, `shared/read.ts`, written in full:

```ts
/** One classified read of one input boundary.
 *
 * Every feed fetch, RPC call, file read and secure-store read returns this
 * type. The three arms are the three things that can be true, and they are the
 * three that AUDIT.md found collapsed into one value thirteen times
 * ("Failed read turned into an empty, zero or default value"):
 *
 *   ok: true,  present: true    the source answered and the thing is there
 *   ok: true,  present: false   the source answered and the thing is not there
 *   ok: false                   the source did not answer
 *
 * "Absent" and "could not read" are different arms, so no `?? []`, no `?? 0`
 * and no `catch { rows = [] }` can turn one into the other without a cast.
 *
 * Generalised from `FeedRead` on feat/merchant-terminal (watcher/src/feed.ts:17),
 * which is this shape for the price feed alone.
 */

export type ReadFailure =
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "http_error"; readonly status: number; readonly detail: string }
  | { readonly kind: "rate_limited"; readonly detail: string }
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "not_yet_available"; readonly detail: string }
  | { readonly kind: "unauthorized"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

/** Where the value came from and when it was observed.
 *
 * `at` is the instant the value was observed, never the instant the caller
 * asked. That distinction is W5 and W6: a scheduler tick written into the
 * field that means a feed window boundary.
 *
 * `stale` is true when the refresh attempt failed and a previously observed
 * value is being served again. That is W4 (a day file cached for the process
 * lifetime) and TM2 (a balance kept across an RPC failure and rendered with no
 * qualifier).
 */
export type Provenance = {
  readonly source: string;
  readonly at: Date;
  readonly stale: boolean;
};

export type Read<T> =
  | ({ readonly ok: true; readonly present: true; readonly value: T } & Provenance)
  | ({ readonly ok: true; readonly present: false } & Provenance)
  | ({ readonly ok: false; readonly failure: ReadFailure } & Provenance);

/** The only arm carrying a value. A function that needs the value takes this,
 *  so a caller cannot hand it a read it has not narrowed. */
export type Observed<T> = Extract<Read<T>, { ok: true; present: true }>;

export function observed<T>(value: T, p: Provenance): Read<T> {
  return { ok: true, present: true, value, source: p.source, at: p.at, stale: p.stale };
}

export function absent<T>(p: Provenance): Read<T> {
  return { ok: true, present: false, source: p.source, at: p.at, stale: p.stale };
}

export function unread<T>(failure: ReadFailure, p: Provenance): Read<T> {
  return { ok: false, failure, source: p.source, at: p.at, stale: p.stale };
}

export function at(source: string, when: Date, stale = false): Provenance {
  return { source, at: when, stale };
}

/** True only when the source answered and said there is nothing.
 *
 *  The one predicate a screen, a report or a verdict may consult before
 *  printing "none", "no", "empty", "zero" or "yet". */
export function mayClaimAbsence<T>(read: Read<T>): boolean {
  return read.ok && !read.present;
}

export function isObserved<T>(read: Read<T>): read is Observed<T> {
  return read.ok && read.present;
}

/** Map an observed value. Never flattens a failure and never loses provenance. */
export function mapRead<T, U>(read: Read<T>, f: (value: T) => U): Read<U> {
  const p: Provenance = { source: read.source, at: read.at, stale: read.stale };
  if (!read.ok) return unread<U>(read.failure, p);
  if (!read.present) return absent<U>(p);
  return observed<U>(f(read.value), p);
}

/** Lift a nullable result into the absent arm.
 *
 *  `getAccountInfo` returning null is an observed absence. The call throwing is
 *  not. W7 is exactly this confusion: `parsed?.meta?.logMessages ?? []` at
 *  watcher/src/chain.ts:104 turns "never read" into "read, and it carried
 *  nothing", and the message downstream asserts the second. */
export function absentIfNull<T>(read: Read<T | null>): Read<T> {
  if (!read.ok) return unread<T>(read.failure, read);
  if (!read.present || read.value === null) return absent<T>(read);
  return observed<T>(read.value, read);
}

/** The rate-limit pattern already shipping on feat/rpc-resilience
 *  (watcher/src/rpc.ts:23). Kept identical so the two do not drift. */
const RATE_LIMIT_RE = /\b429\b|too many requests|rate limit/i;
const UNAUTHORIZED_RE = /\b401\b|\b403\b|unauthorized|forbidden/i;
const UNREACHABLE_RE = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|aborted|timeout/i;

/** Classify a thrown value.
 *
 *  The last arm is `unknown`, not `malformed`. Calling an unrecognised error
 *  "malformed" would be this defect class inside its own fix: `malformed` is a
 *  statement about a body somebody read, and nobody read one here. */
export function classifyThrown(err: unknown): ReadFailure {
  const detail = err instanceof Error ? err.message : String(err);
  if (RATE_LIMIT_RE.test(detail)) return { kind: "rate_limited", detail };
  if (UNAUTHORIZED_RE.test(detail)) return { kind: "unauthorized", detail };
  if (UNREACHABLE_RE.test(detail)) return { kind: "unreachable", detail };
  return { kind: "unknown", detail };
}

/** Run a read and classify its outcome.
 *
 *  This is the replacement for every `try { ... } catch { x = [] }` in the
 *  tree. The catch still exists; it produces a failure arm instead of a value. */
export async function attempt<T>(
  source: string,
  run: () => Promise<T>,
  clock: () => Date = () => new Date(),
): Promise<Read<T>> {
  try {
    return observed(await run(), at(source, clock()));
  } catch (err) {
    return unread<T>(classifyThrown(err), at(source, clock()));
  }
}
```

What this removes as a class, by audit id: W3, W7, W10, I7, I11, T5, T6, T7, A3, A5, A14, TM2, and
the `stale` field carries W4 and TM2's qualifier into the type rather than into a comment. Thirteen
of the 42 mechanical instances, and it is the shape the two prototypes already converged on
independently.

## 1.3 M2: no endpoint, account, mint or program has a default anywhere

New file, `shared/config.ts`, written in full:

```ts
/** No endpoint, account, mint or program has a default anywhere in this repo.
 *
 * Twelve of the 66 audited instances are a chain identity or a cluster label
 * resolved to a constant. The rule is not a lint, because a lint over `??`
 * would need about forty exemptions on this tree and would still miss
 * `process.env.VETO_RPC ?? DEFAULT_RPC` (indexer/src/cli.ts:21), which is a
 * named constant rather than a literal.
 *
 * `Configured<N>` is a branded string with exactly one constructor, so:
 *
 *   const rpc: RpcEndpoint = "https://api.devnet.solana.com";   // does not compile
 *   const rpc = requireVar("VETO_RPC", source);                 // compiles
 *
 * Every function that takes an endpoint, an account, a mint or a program takes
 * the branded type, so the constant cannot reach it.
 */

declare const CONFIGURED: unique symbol;

/** A string that can only have come from the named configuration variable. */
export type Configured<Name extends string> = string & {
  readonly [CONFIGURED]: Name;
};

export type RpcEndpoint = Configured<"VETO_RPC">;
export type ProgramId = Configured<"VETO_PROGRAM_ID">;
export type MintAddress = Configured<"VETO_MINT">;
export type OwnerAddress = Configured<"VETO_OWNER">;
export type OwnerTokenAccount = Configured<"VETO_OWNER_TOKEN">;
export type MerchantAddress = Configured<"VETO_MERCHANT">;
export type MerchantTokenAccount = Configured<"VETO_MERCHANT_TOKEN">;
export type AgentAddress = Configured<"VETO_AGENT">;

/** Loud, and it names the variable and every place that was searched. */
export class MissingConfig extends Error {
  readonly variable: string;
  readonly searched: readonly string[];

  constructor(variable: string, searched: readonly string[]) {
    super(
      `missing ${variable}. This repo has no default for an endpoint, an account, a mint or a ` +
        `program: a default would make the process act on an address nobody chose. Set ` +
        `${variable} in the environment, or in one of: ${searched.join(", ")}.`,
    );
    this.name = "MissingConfig";
    this.variable = variable;
    this.searched = searched;
  }
}

export type ConfigSource = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly files: ReadonlyMap<string, string>;
  /** Paths consulted, in order, named back in the error. */
  readonly searched: readonly string[];
};

/** The only constructor of a Configured value, and the only sanctioned cast in
 *  the repo. The shapes test in 1.5 forbids `as Configured` in every other file. */
export function requireVar<N extends string>(name: N, from: ConfigSource): Configured<N> {
  const fromEnv = from.env[name];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim() as Configured<N>;
  }
  const fromFile = from.files.get(name);
  if (fromFile !== undefined && fromFile.trim().length > 0) {
    return fromFile.trim() as Configured<N>;
  }
  throw new MissingConfig(name, from.searched);
}

/** Optional by policy, not by accident. A variable is allowed to be absent
 *  only where a caller has written down what absence means. */
export function optionalVar<N extends string>(name: N, from: ConfigSource): Configured<N> | null {
  try {
    return requireVar(name, from);
  } catch (err) {
    if (err instanceof MissingConfig) return null;
    throw err;
  }
}

/** A cluster name is never configured and never defaulted. It is derived from
 *  the genesis hash of the connection already in hand.
 *
 *  This removes T3, A1, S1, S2, D2 and TM1 as a class. S1 writes
 *  `CLUSTER=devnet` unconditionally (scripts/devnet-setup.sh:589) while
 *  `CLUSTER_NAME` has been in scope since line 21. TM1 decides the cluster by
 *  testing the RPC url for the substring "devnet". T3 stamps `cluster: devnet`
 *  into every exported record eight lines before reading the genesis hash from
 *  the same connection and never comparing them. None of those is expressible
 *  once the only producer of a cluster name takes a genesis hash.
 */
export type ClusterName = "mainnet-beta" | "devnet" | "testnet" | "unrecognised";

export const GENESIS_HASH: Readonly<Record<Exclude<ClusterName, "unrecognised">, string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};

export function clusterFromGenesis(hash: string): ClusterName {
  for (const name of ["mainnet-beta", "devnet", "testnet"] as const) {
    if (GENESIS_HASH[name] === hash) return name;
  }
  return "unrecognised";
}

/** The explorer query string for a cluster, or null when there must be no link.
 *
 *  "unrecognised" gets no link rather than a mainnet link, because a link that
 *  silently resolves against the wrong chain is TM1 and A1. */
export function explorerQuery(cluster: ClusterName): string | null {
  if (cluster === "mainnet-beta") return "";
  if (cluster === "unrecognised") return null;
  return `?cluster=${cluster}`;
}
```

**One unverified fact, named rather than asserted.** The three genesis hashes above are written from
knowledge, not from this worktree: `solana` is not on PATH here (`command -v solana` returns
nothing), and the repo contains no genesis-hash-to-cluster table today. Confirm all three with
`solana genesis-hash --url mainnet-beta`, `--url devnet` and `--url testnet` before merging
`shared/config.ts`. Until that is done the constants are the same category of claim this audit is
about, and they should be treated that way.

The loader that consumes this already exists: `required(env, files, key)` on
`feat/merchant-terminal` (`watcher/src/config.ts`, commit `c41c088`) throws naming the variable and
the four files searched. M2 is that function promoted out of one package and given a type that makes
the alternative uncompilable, instead of merely absent.

## 1.4 M3: one shared state type for anything that displays what was read

New file, `shared/readState.ts`, written in full:

```ts
import type { Read, ReadFailure } from "./read.js";

/** What a surface knows about a read it is about to display.
 *
 *  Generalises app/lib/mandateRead.ts, which AUDIT.md names as the reason
 *  several app screens are clean. That file is a five-value string union for
 *  one read. This is the same idea for every read, with the value in the type.
 */
export type ReadState<T> =
  | { readonly phase: "not-read" }
  | { readonly phase: "reading"; readonly since: Date }
  | { readonly phase: "read"; readonly read: Read<T> };

export const NOT_READ: ReadState<never> = { phase: "not-read" };

/** Exhaustive by construction.
 *
 *  Every surface that shows a read goes through here, so the sentence for an
 *  empty result can only be written inside `absent`, which is only reachable
 *  when the source answered. "No rulesets saved on this phone yet." (A14),
 *  "No payments received yet." (TM3) and "This RPC did not return a transaction
 *  signature for this row." (A5) are today reachable from a failed read. After
 *  this they are not: a failed read lands in `failed` and the compiler will not
 *  let it reach `absent`.
 *
 *  Adding an arm to `Read` or `ReadState` makes every call site a compile error
 *  until it says what to show. That is the point, not a side effect.
 */
export function renderRead<T, R>(
  state: ReadState<T>,
  on: {
    notRead: () => R;
    reading: (since: Date) => R;
    failed: (failure: ReadFailure, source: string) => R;
    absent: (source: string, at: Date) => R;
    present: (value: T, at: Date, stale: boolean) => R;
  },
): R {
  if (state.phase === "not-read") return on.notRead();
  if (state.phase === "reading") return on.reading(state.since);
  const read = state.read;
  if (!read.ok) return on.failed(read.failure, read.source);
  if (!read.present) return on.absent(read.source, read.at);
  return on.present(read.value, read.at, read.stale);
}

/** Default copy for the failed arm. Every sentence says what was not learned,
 *  and none of them claims the answer is none.
 *
 *  The switch has no default clause. Under `noImplicitReturns` a new
 *  `ReadFailure` arm makes this a compile error, which is the ratchet: a new
 *  failure kind cannot be introduced without someone writing its sentence. */
export function failureCopy(failure: ReadFailure): string {
  switch (failure.kind) {
    case "rate_limited":
      return "The RPC is rate limiting this read. Still trying. This is not a stalled fetch.";
    case "unreachable":
      return "This read did not reach the source. Pull to retry. This screen does not assume the answer is none.";
    case "http_error":
      return `The source answered ${failure.status}. Pull to retry. This screen does not assume the answer is none.`;
    case "malformed":
      return "The source answered with something this build could not read. Pull to retry.";
    case "not_yet_available":
      return "Not retrievable yet at this commitment. Pull to retry.";
    case "unauthorized":
      return "This read was refused by the source. Pull to retry.";
    case "unknown":
      return "This read failed. Pull to retry. This screen does not assume the answer is none.";
  }
}

/** Staleness is a fact about the value, so it travels with the value.
 *
 *  TM2 is the case: the payments list eight lines below the balance does
 *  disclose "the list below is from the last successful read at ...", and the
 *  balance row does not. Both come through here after the migration. */
export function staleNote(at: Date): string {
  return `Last successful read at ${at.toISOString()}. The refresh after it failed.`;
}
```

`noImplicitReturns: true` is added to every package tsconfig as part of this change. It is absent
from `watcher/tsconfig.json`, `indexer/tsconfig.json` and `tools/tsconfig.json`. `app/tsconfig.json`
extends `expo/tsconfig.base`, which was not read here because `app/node_modules` is not installed in
this worktree; confirm with `cd app && npx tsc --showConfig | grep noImplicitReturns`. Without the
flag the exhaustiveness in `failureCopy` is decorative.

## 1.5 M4: a repository test that fails on the banned shapes

The test lives at `tools/shapes.test.ts` because `tools` already runs `tsx --test *.test.ts` in CI
(`.github/workflows/ci.yml:106`) and `tools/tsconfig.json` already includes files outside its own
directory. No new CI job, no new package, no new dependency.

```ts
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dirname, "..");

function tracked(pattern: RegExp): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((p) => p.length > 0 && pattern.test(p));
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** One line per exemption, `<path>:<line> <reason>`. An exemption is visible in
 *  review; a silent skip is not. Seeded on day one with the 42 mechanical
 *  instances from AUDIT.md so the ratchet goes green immediately and every new
 *  site fails. The list is burned down, never appended to. */
const ALLOW = new Set(
  read("docs/assessment/allowed-shapes.txt")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.split(/\s+/)[0] ?? ""),
);

function violations(path: string, re: RegExp): string[] {
  const hits: string[] = [];
  read(path).split("\n").forEach((line, i) => {
    if (!re.test(line)) return;
    const site = `${path}:${i + 1}`;
    if (!ALLOW.has(site)) hits.push(`${site}  ${line.trim()}`);
  });
  return hits;
}

const SRC = /\.(ts|tsx)$/;
const NOT_TEST = (p: string) => !p.includes(".test.");

// R1. The vendored copies of the shared types are byte identical.
//
// There is no workspace here: watcher and indexer set `rootDir: "src"` and emit
// to dist/, and watcher/package.json runs `node dist/index.js run` while
// indexer declares `bin: ./dist/cli.js`. Adding ../shared to their include
// moves those entry points and breaks scripts/watcher-service.sh:79. Metro's
// project root is app/ (app/metro.config.js), so the app cannot reach outside
// it without watchFolders. Copies plus this test cost less than either.
test("the shared types are identical in every package", () => {
  for (const name of ["read.ts", "config.ts", "readState.ts"]) {
    const canonical = read(join("shared", name));
    for (const copy of [
      join("watcher", "src", name),
      join("indexer", "src", name),
      join("app", "lib", name),
      join("terminal", "src", name),
    ]) {
      if (!existsSync(join(ROOT, copy))) continue; // terminal is branch only
      assert.equal(read(copy), canonical, `${copy} has drifted from shared/${name}`);
    }
  }
});

// R2. Only shared/config.ts may mint a Configured value.
test("no package casts its way to a configured identity", () => {
  const hits = tracked(SRC)
    .filter((p) => p !== "shared/config.ts" && !p.endsWith("/config.ts"))
    .flatMap((p) => violations(p, /\bas\s+(Configured|RpcEndpoint|ProgramId|MintAddress|OwnerAddress|AgentAddress)\b/));
  assert.deepEqual(hits, []);
});

// R3. No base58-shaped address literal outside the allowlist.
//
// Catches W1, W2, I1, I2, I3, T1, T2, A12 and anything written after them.
// Keys, the IDL, declare_id and test fixtures are not source and are excluded
// by path; the token program id and the genesis hashes are on the allowlist by
// site, with a reason.
const BASE58 = /["'][1-9A-HJ-NP-Za-km-z]{32,44}["']/;
test("no chain identity is written as a literal", () => {
  const hits = tracked(SRC)
    .filter(NOT_TEST)
    .filter((p) => !p.startsWith("keys/"))
    .flatMap((p) => violations(p, BASE58));
  assert.deepEqual(hits, []);
});

// R4. No url literal outside the allowlist. Catches the other half of the
// twelve, including http://127.0.0.1:8999 and https://api.devnet.solana.com.
test("no endpoint is written as a literal", () => {
  const hits = tracked(SRC)
    .filter(NOT_TEST)
    .flatMap((p) => violations(p, /["']https?:\/\/[^"']+["']/));
  assert.deepEqual(hits, []);
});

// R5. No catch block that swallows a read into an empty, zero or default value.
//
// Matched across the whole file rather than per line, because the shape spans
// lines: app/lib/chain.ts:327-329 is `catch {` / `signatures = [];` / `}`.
const SWALLOW =
  /catch\s*(\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\n\s*)*[A-Za-z_$][\w$.]*\s*=\s*(\[\]|0|0n|""|''|null|\{\})\s*;?\s*\}/g;
test("no catch turns a failed read into a value", () => {
  const hits: string[] = [];
  for (const p of tracked(SRC).filter(NOT_TEST)) {
    const text = read(p);
    for (const m of text.matchAll(SWALLOW)) {
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      const site = `${p}:${line}`;
      if (!ALLOW.has(site)) hits.push(`${site}  ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(hits, []);
});

// R6. The shell. Five of the 42 live here and no TypeScript rule reaches them.
//
// S4, S5 and S6: `|| printf '0'` and `2>/dev/null || echo 0` answer a failed
// read with a number. S6 additionally swallows the python exit code that was
// the whole check.
test("no shell command answers a failed read with a number", () => {
  const hits = tracked(/\.sh$/)
    .filter((p) => !p.endsWith(".test.sh"))
    .flatMap((p) => violations(p, /\|\|\s*(printf|echo)\b/));
  assert.deepEqual(hits, []);
});

test("every shell script fails on a failed pipe", () => {
  for (const p of tracked(/\.sh$/)) {
    assert.match(read(p), /set -[a-z]*o pipefail|set -o pipefail/, `${p} does not set pipefail`);
  }
});

// R7. A check that does not run. C1 exactly: the app job runs `npx tsc --noEmit`
// beside three jobs that run `npm test`, over thirteen test files that never run.
test("every package with a test script runs it in CI", () => {
  const ci = read(".github/workflows/ci.yml");
  for (const p of tracked(/package\.json$/)) {
    if (p.includes("node_modules")) continue;
    const pkg = JSON.parse(read(p)) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test === undefined) continue;
    const dir = p.split("/")[0] ?? "";
    const job = ci.split(/\n(?=  \w)/).find((b) => b.includes(`working-directory: ${dir}`));
    assert.ok(job !== undefined, `${dir} has a test script and no CI job`);
    assert.match(job, /npm test/, `the ${dir} CI job does not run npm test`);
  }
});

// R8. app/package.json enumerates its test files by hand. Thirteen listed,
// thirteen on disk today. A fourteenth would run nowhere and nothing would say so.
test("the app runs every test file it has", () => {
  const pkg = JSON.parse(read("app/package.json")) as { scripts: { test: string } };
  for (const f of tracked(/^app\/lib\/.*\.test\.ts$/)) {
    assert.ok(pkg.scripts.test.includes(f.replace("app/", "")), `${f} is not in app/package.json test`);
  }
});
```

**The allowlist is the reason this is affordable.** `docs/assessment/allowed-shapes.txt` is seeded on
day one with the 42 mechanical sites AUDIT.md already lists, one line each with its audit id as the
reason. The test is green the hour it lands, and from that hour on **every new instance fails CI**.
The 42 are then removed from the list as each site is fixed, and the file only ever shrinks. This is
what turns a two-week migration into a two-day mechanism.

## 1.6 Where the files live, and why there are copies

`shared/read.ts`, `shared/config.ts` and `shared/readState.ts` are the canonical files. They have no
dependencies and no package.json.

`tools` and `terminal` import them directly. Both set `noEmit: true`, `tools/tsconfig.json` already
includes `../indexer/src/**/*.ts`, and `terminal/src/page.ts:9` on its branch already imports
`../../watcher/src/feed.js`. The pattern is established and costs one line in each `include`.

`watcher`, `indexer` and `app` take byte-identical copies, pinned by R1. The reason is mechanical,
not stylistic:

- `watcher/tsconfig.json` and `indexer/tsconfig.json` set `rootDir: "src"` and emit to `dist/`.
  Adding `../shared` to the include moves `dist/index.js` to `dist/watcher/src/index.js`, which
  breaks `watcher/package.json`'s `node dist/index.js run`, `indexer`'s `bin: ./dist/cli.js`, and
  `scripts/watcher-service.sh:79`, which greps for the string `dist/index.js run`.
- `app/metro.config.js` is `getDefaultConfig(__dirname)`, so Metro's project root is `app/`. Reaching
  outside it needs `watchFolders` plus a tsconfig path, on a bundler that is already the highest
  risk item in `docs/PLAN.md:160`.

Copies with a failing test are worse engineering than a workspace and better engineering than
relinking three build outputs eighteen days from a deadline. Say so in the commit and revisit after.

## 1.7 What this cannot catch

Honestly, and using the audit's own judgment cases.

**It cannot catch a sentence that is braver than a correct read.** Every one of these survives the
whole mechanism intact:

- **A11**, "Your rule held. No payment made." in the largest type on the refusal card. The read is
  correct, the reason code is correct, and for reasons 7, 8 and 10 the rule is not what stopped it.
- **T9**, "Mandate limits, ledger entry, and charge transaction agree" printed on the log-only path
  where no ledger entry was read. Every individual check is right. The closing sentence is the defect
  and it contradicts a note printed four lines above it.
- **T8**, "VERDICT: CONFIRMED, empty export: no paid or refused charges in this scope", which is a
  true sentence about a file presented as a sentence about the chain. `Read<T>` has no opinion,
  because the file read succeeded.
- **I10**, "matched exactly: N" computed after filtering out every timestamp diff. The filter is
  deliberate and the word is the defect.
- **P1**, the refusal log line printing `per_tx_max=` and `remaining=` for reasons that had nothing
  to do with either. The fields are factually the mandate's own limits.
- **A9 and A10**, `completeness: "payments"` on the file and "The complete record this phone can
  rebuild from the ring and logs" on the screen. M3 makes the qualifier representable and forces the
  failed and absent arms to carry copy. Nothing in it forces `app/lib/exportRecord.ts:5`,
  `export const COMPLETENESS = 'payments' as const`, to stop being a literal written before a
  single row was counted.
- **TM3**, "No payments received yet" over a ten-signature window. M3 does force that sentence into
  the `absent` arm, which fixes the failed-read half. It does not fix the bounded-window half: the
  read genuinely succeeded and genuinely found nothing in ten signatures.

**It cannot decide that two things are different kinds.** W5 writes a scheduler tick into
`window_start`; both are `string`. A branded `WindowStart` versus `ObservedAt` would catch it, using
the same machinery as `Configured<N>`, and it is cheap. But the decision that a feed window boundary
and a wall clock are different kinds was the audit's, not the type's. The type can only hold a
decision somebody made.

**It cannot catch a bounded scan presented as a complete one.** A6 (four pages of fifty), I8
(`maxSlots` 50000), TM3 (ten signatures). Each read succeeded. The claim around it is the defect, and
`Read<T>` has no field for "and this is all of them" that anyone is obliged to fill.

**Rough split.** Of the 24 judgment instances, M1 to M4 reach zero directly. M3 forces the copy for
three of them into an arm where the copy has to be written deliberately (A14 is mechanical and is
fixed; TM3 and A5 are half-fixed). The other 21 are fixed by one deliberate reading pass over each
user-visible sentence, which is what AUDIT.md is, and which is scheduled as a named block in Part
two rather than left to good intentions.

## 1.8 What it costs to migrate each package

Boundary counts are from this tree, non-test sources only.

| Package | Instances | Catch blocks | Identity sites | Files touched | Build risk | Collides with | Cost |
|---|---|---|---|---|---|---|---|
| `tools` | 11 | 9 | 3 | 5 | none, `noEmit` | `feat/rpc-resilience` (7 files) | **0.5 day.** Imports `shared/` directly, one line in `include`. Cheapest package, and it hosts the shapes test |
| `indexer` | 11 | 6 | 4 | 5 | vendored copy, `rootDir` and `bin` unchanged | `feat/rpc-resilience` (6 files) | **1 day.** I4 is one keystroke: make `programId` required and the type does the work |
| `watcher` | 10 | 5 | 8 | 6 | vendored copy, `dist/index.js` path preserved | `feat/rpc-resilience` and `feat/merchant-terminal`, both | **1 day**, and about half of it is already written: `c41c088` replaces `DEFAULTS` with a throwing loader and ships `watcher/src/config.test.ts` |
| `app` | 17 | 23 | 3 | ~12 | vendored copy, no Metro change | `feat/app-override` (`chain.ts`, `useChain.ts`) | **2 days.** Largest surface and the most catch blocks, but `mandateRead.ts` and `ReadState.tsx` are the target pattern already, so this is mostly renaming five string states into three arms |
| `scripts` | 8 | n/a | 1 | 1 | none | none | **0.5 day.** `set -o pipefail`, `die` where `|| printf '0'` is today, and `${CLUSTER_NAME}` at line 589 instead of the literal. Highest defect density in the repo and the smallest fix |
| `terminal` | 3 | n/a | 2 | 3 | none, `noEmit` | it is the branch | **0.5 day**, folded into the rebase. Its `FeedRead` becomes `Read<PriceWindow>`; it is the source of the design |
| `programs` | 2 | n/a | n/a | 0 | n/a | n/a | **0.** Frozen (`docs/PLAN.md:73`). P1 and P2 are recorded, not actioned |
| CI and docs | 4 | n/a | n/a | 3 | none | `feat/rpc-resilience` touches `ci.yml` | **0.5 day.** C1 is four lines in the `app` job. D1 and D2 become true once W1 and S1 are fixed |

Total migration, if every allowlist line is burned down: about 6 days of the 18. **That is why it is
not all scheduled.** The mechanism itself, M1 through M4 with the allowlist seeded and nothing
migrated, is **2 days**, and it is the only part that has to land early.

---

# Part two: the eighteen days

## 2.1 The ordering principle

The mechanism goes first, and not because it is important. It goes first because three large
unmerged branches are about to be rebased across exactly the files it changes, and whichever lands
second gets written twice.

Measured, not assumed:

```
$ git diff --name-only main...feat/rpc-resilience | wc -l    # 28 files, 5 ahead, 7 behind
$ git diff --name-only main...feat/merchant-terminal | wc -l # 31 files, 3 ahead, 7 behind
$ git diff --name-only main...feat/app-override | wc -l      # 22 files, 3 ahead, 5 behind
```

`feat/rpc-resilience` touches `indexer/src/cli.ts` (I1, I2), `indexer/src/seed.ts` (I3, I5, I6),
`tools/lib.ts` (T1, T2, T3), `tools/produce.ts` (T11), `tools/verify.ts` (T9, T10),
`watcher/src/chain.ts` (W7, W8, W9), `watcher/src/config.ts` (W1, W2), `watcher/src/run.ts` (W5, W6),
`watcher/src/journal.ts` (W10) and `.github/workflows/ci.yml` (C1). That is **seventeen audited sites
in one branch.** Every new failover path it adds is currently written against the collapsed shapes.
Merge it first and those paths are rewritten during the migration. Land M1 first and they are
written once, against `Read<T>`, by the rebase that has to happen anyway.

`feat/merchant-terminal` is the second reason. It carries the two prototypes: `FeedRead` in
`watcher/src/feed.ts` and the throwing config loader in `watcher/src/config.ts`. Merging it before
`shared/` forks the mechanism into a package-local version, which is the precise failure AUDIT.md
describes six times over in its closing observation.

`feat/app-override` adds `useOverrideGrant.ts`, which re-probes the chain after a failed read. That
is a new boundary, written against the old shapes.

Push notifications are the fourth reason, and the sharpest: they are an entirely new input boundary
that does not exist yet. Written before M1, they become instance 67.

## 2.2 The schedule

| Dates | Work | Why here |
|---|---|---|
| **Sep 21 to 22** | **M1 to M4.** Three files in `shared/`, five vendored copies, `tools/shapes.test.ts`, `docs/assessment/allowed-shapes.txt` seeded with the 42, `noImplicitReturns` in four tsconfigs, and the four-line fix to the `app` CI job (C1). **No call sites migrated.** | Everything below is written against it. Two days, hard capped. If it is not merged by end of Sep 22 it is cut to M1 plus M4 only and the config policy waits |
| **Sep 23 to 24** | Rebase and merge **`feat/rpc-resilience`** onto M1. Its own fixes retire roughly ten allowlist lines as a side effect | Seventeen audited sites, the largest double-write exposure in the tree. Also the branch that keeps the seven-day history from having holes, and holes in the history are what kill the Stickiness argument (`docs/PLAN.md:156`) |
| **Sep 25 to 26** | Rebase and merge **`feat/merchant-terminal`**. Promote its `FeedRead` into `shared/read.ts` rather than beside it, and its throwing loader into `shared/config.ts`. Retires W1, W2, TM1, TM2 | Second largest overlap, and it holds the design the mechanism is generalised from. Merging it after M1 means the generalisation is done once |
| **Sep 27 to 28** | Rebase and merge **`feat/app-override`**. Migrate `app/lib/chain.ts` and `useChain.ts` in the same pass, since the branch already rewrites both. Retires A3, A5 | The last branch that touches migration files. After this the tree has one shape |
| **Sep 29 to 30** | **Push notifications**, written on `Read<T>` from the first line | New boundary. Cheap now, an instance if written earlier |
| **Oct 1 to 2** | **The judgment pass.** One deliberate reading of every user-visible sentence on the four surfaces a judge looks at: the refusal card, the decision record, the verifier verdict, the merchant screen. Eleven instances: P1, I10, T4, T8, T9, T10, A7, A9, A10, A11, TM3 | Scheduled, because no tool does it and because AUDIT.md's conclusion is that this is where the product is. Two days, and it is a reading pass plus copy edits, not a refactor |
| **Oct 3** | **Signed release APK, installed on a wiped Seeker.** Not a simulator, not a dev client | Five days before submission, because a signing or install failure is only ever discovered by doing it, and `docs/PLAN.md:160` already names Expo plus MWA plus Seed Vault as where hackathons die |
| **Oct 4 to 5** | **Deck.** The prior-art slide first (`docs/PLAN.md:29-45`), then the two-path demo, then the real week of history. `docs/deck-refresh` rebased in | Presentation is 25% and the prior-art slide is the single highest-leverage artifact in the submission |
| **Oct 6** | **Video**, three minutes, shot on device | Plan's own date |
| **Oct 7** | Re-shoot and buffer | Plan's own reserve day. The only slack in eighteen days |
| **Oct 8** | **Submit on Align** | True cutoff is 08:59 on Oct 9; the night is reserve and is not to be planned against |

Slack: one day, Oct 7, and it is already spoken for as the re-shoot. That is the whole reason there
is a cut list rather than a hope.

## 2.3 What I would cut, ranked, and why

Ranked by what is lost, cheapest first. Cut from the top as the schedule slips.

**1. The allowlist burn-down, everywhere except the four demo surfaces.**
Lost: nothing a judge sees. The ratchet stops new instances the day M4 lands; burning down the 42 is
hygiene. Keep only the sites behind the refusal card, the decision record, the verifier and the
merchant screen, because those are on camera. Saves up to 4 days. **This is the first thing to go and
it should probably go regardless.**

**2. `Configured<N>` applied beyond the loaders.**
Lost: drift protection. The throwing loader from `c41c088` already fixes the behaviour; the brand
stops it coming back. Keep `requireVar` and `MissingConfig`, drop the branded types from function
signatures across `indexer` and `tools`. Saves about 1 day. Reversible in an afternoon later.

**3. Push notifications.**
Lost: one demo beat and a sentence in the Stickiness argument. `docs/PLAN.md:122` wants push "because
the habit is the agent acting while you are not looking", and that is a good line, but the Stickiness
case rests on the history being real (`docs/PLAN.md:156`) and the watcher already makes it real. Cost
is a notification service integration, a new input boundary and a device test, against one beat.
Highest cost-to-score ratio of anything remaining. Saves 2 days.

**4. The override *grant* flow from the phone.**
Lost: the second MWA signing path, not the differentiator. `docs/PLAN.md:89-91` calls the actionable
suggestion the one addition worth making, and it already ships: the program emits
`suggested_override` and the refusal card shows it (handoff F1). Cut to showing the suggestion on the
card and granting from a desktop signer during the demo, which is the identical trade the plan
already permits for `open_mandate` at its Oct 1 cut line. `feat/app-override` stays on its branch and
is named as built-not-merged, honestly, or not named at all. Saves 2 days.

**5. Merging `feat/merchant-terminal` to main.**
Lost: a strong visual, and the merchant screen in the video. Keep the branch running locally for the
shot; do not merge, do not migrate, do not claim it in the submission's built list. The cost here is
only the rebase, since the code exists with three rounds of critic fixtures already on it, so this is
a cheap cut to reverse. But it also means `FeedRead` never generalises, so if this is cut, cut it
*before* Sep 25 and build `shared/read.ts` from the branch by reading rather than merging. Saves 2
days.

**6. The judgment pass, narrowed from four surfaces to two.**
Lost: real credibility, and this is where it starts hurting. If it must be cut, keep the refusal card
(A11) and the verifier verdict (T8, T9, T10) and drop the decision record and the merchant screen.
The refusal card is the product in one sentence and the verdict is what a security researcher on the
judging panel will actually run. Saves 1 day. **Cut this only after everything above it.**

## 2.4 What I would not cut, at any point

- **The two days for M1 to M4.** Cutting it saves two days and costs the four to six days of rework
  that Part 2.1 measures. It is the only item on the list that is cheaper than its own absence.
- **`feat/rpc-resilience`.** It is what stops the seven-day history having holes. A gapped history
  breaks the one claim the entry is built on. If it somehow has to shrink, keep the classified retry
  and drop the multi-endpoint failover.
- **The signed APK on a wiped device, on Oct 3.** Not Oct 7.
- **The video and the submission.** Obviously, and stated so that nothing above ever silently
  borrows from them.

---

# The fleet question

**The producer routing is a red herring as a cause. It is a real and separate failure of
propagation. Those are different claims and only the second one survives the evidence.**

## It is not a cause

**There is no clean package.** All eight sections of the audit have instances, across four languages:
Rust 2, TypeScript 52, shell 8, YAML 1, Markdown 3. No seat produced a package free of the defect and
no seat produced a package where it clusters alone.

**Normalising by size inverts the raw ranking.** Instances per thousand non-test source lines, counted
from this tree:

| Package | Instances | Source lines | Per 1000 lines |
|---|---|---|---|
| `scripts` | 8 | 700 | **11.4** |
| `indexer` | 11 | 1265 | **8.7** |
| `tools` | 11 | 2152 | 5.1 |
| `watcher` | 10 | 2088 | 4.8 |
| `terminal` | 3 | 720 | 4.2 |
| `app` | 17 | 6167 | **2.8** |
| `programs` | 2 | 2257 | 0.9 |

The package with the most instances in absolute terms has the second-lowest density, and it is also
the largest surface by a factor of three. The highest density is a 700-line shell script. If the seat
were the variable, the ordering would not invert when you divide by size.

**The decisive fact is in one package, in one pair of commits.** `app/lib/mandateRead.ts` is the best
defence in this repository. AUDIT.md's "Looked at and not counted" section names it explicitly: "the
opposite of this defect class, and the reason several app screens are clean. `mayClaimAbsence` exists
precisely to stop a failed read being rendered as an empty one." `app/lib/chain.ts` holds A5, A6 and
A15.

```
$ git log --oneline -- app/lib/mandateRead.ts
c949ef1 feat(mobile): rebuild the owner app as a three-tab fleet console (#62)
7efc8c9 feat(mobile): owner screens for mandate, today, ledger and revoke (#38)

$ git log --oneline -- app/lib/chain.ts
c949ef1 feat(mobile): rebuild the owner app as a three-tab fleet console (#62)
7efc8c9 feat(mobile): owner screens for mandate, today, ledger and revoke (#38)
```

The same two commits. The same seat, the same package, the same pull request. The producer that wrote
the counter-pattern wrote three instances of the defect in the same change. Seat identity does not
predict the defect; the number of input boundaries in the file does.

**Language predicts it better than anything about who wrote it.** The frozen Rust program, with no
input boundaries at all, has the lowest density. The shell script, with no type system and eight
external command reads, has the highest by a factor of four. That is the whole gradient.

## It is a real propagation failure, which is a different thing

AUDIT.md's closing observation stands on its own evidence and I am not softening it: "the same defect
is repeatedly fixed in one package and left in the others." Six of the 42 mechanical instances are a
correct implementation sitting one directory from an incorrect one.

- `FeedRead` classifies the feed on `feat/merchant-terminal`; `watcher/src/run.ts` on `main` still
  consumes the collapsed `null` (W3).
- The defaults removal reached `app/lib/appConfig.ts:42-52` and, on a branch, `watcher`; `indexer`
  and `tools` still resolve four identities and a cluster name to constants (I1, I2, I3, T1, T2, T3).
- The 65-byte `Refused` event is decoded correctly at `indexer/src/events.ts:54,62` and incorrectly
  at `app/lib/events.ts:68`, where the guard `raw.length >= 73` is never true (A8).
- `parseChargeLogs` exists in `watcher` and is not used by `indexer/src/seed.ts` or
  `tools/produce.ts`, both of which label charges from the amounts they chose (I6, T11).

That is routing. A fix travelled as far as one seat's boundary and stopped.

## What follows for the fleet, stated plainly

**Do not re-route and do not add a review seat.** Neither would have moved any of those six. More
review on the terminal branch would have produced a better `FeedRead`, in the terminal, still. The
propagation failure is not a shortage of attention, it is the absence of a shared file: there is no
workspace here, each package has its own `package.json` and its own `tsc`, and a good idea has
nowhere to live except the package that had it.

The fix for the routing problem and the fix for the defect class are the same artifact. Put the type
in the tree at `shared/`, pin the copies with R1, and fail the build on the banned shapes. Then a fix
does not have to be carried by whoever remembers it.

## The limit of this answer, stated rather than hedged around

The audit sections by package, not by seat, and there is no per-seat dataset to section by: every
commit on `main` carries one human author.

```
$ git shortlog -sne main
    26  Arlen Rios <arlen@blackaces.se>
    17  Arlen <arlenrios@icloud.com>
     2  Arlen Rios <arlenrios@icloud.com>
```

The package-to-seat mapping is inferred from branch names and one reference in the tree,
`docs/SELF_REVIEW.md:90` ("Introduced by the mobile seat"). So the evidence is package-level.

That limit cuts one way, not both. It weakens any *positive* causal claim about routing far more than
it weakens the negative one, because the single place in this repo where a seat can be identified is
`app`, and there the counter-pattern and the defect are in the same hand, in the same commit, on the
same day. To rescue routing as a cause you would need a seat whose output is systematically worse
after correcting for boundary count, and the one seat that can be identified is the one whose output
is systematically better.
