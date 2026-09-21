import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  gcsStore,
  hydrateLocalJournal,
  memoryStore,
  parseGsUri,
  persistLocalJournal,
  persistRecordedDecision,
} from "./journalStore.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "veto-journal-store-"));
}

test("parseGsUri reads bucket and object from a gs URI", () => {
  assert.deepEqual(parseGsUri("gs://veto-journal/decisions.jsonl"), {
    bucket: "veto-journal",
    object: "decisions.jsonl",
  });
  assert.deepEqual(parseGsUri("gs://veto-journal/path/to/decisions.jsonl"), {
    bucket: "veto-journal",
    object: "path/to/decisions.jsonl",
  });
});

test("parseGsUri refuses a URI that is not a gs object", () => {
  assert.throws(() => parseGsUri("https://example/x"), /gs:\/\/bucket\/object/);
  assert.throws(() => parseGsUri("gs://bucketonly"), /gs:\/\/bucket\/object/);
  assert.throws(() => parseGsUri("gs://bucket/"), /gs:\/\/bucket\/object/);
});

test("memoryStore download returns null when empty and the body after upload", async () => {
  const store = memoryStore();
  assert.equal(await store.download(), null);
  await store.upload('{"decision":"paid"}\n');
  assert.equal(await store.download(), '{"decision":"paid"}\n');
});

test("hydrateLocalJournal writes the downloaded body onto the local path", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = memoryStore('{"decision":"refused"}\n');
  await hydrateLocalJournal(path, store);
  assert.equal(readFileSync(path, "utf8"), '{"decision":"refused"}\n');
});

test("hydrateLocalJournal leaves no local file when the object is missing", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  await hydrateLocalJournal(path, memoryStore());
  assert.equal(existsSync(path), false);
});

test("hydrateLocalJournal throws on a download failure and does not write a file", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  const store = {
    async download(): Promise<string | null> {
      throw new Error("journal store: download failed status=503");
    },
    async upload(): Promise<void> {},
  };
  await assert.rejects(() => hydrateLocalJournal(path, store), /download failed/);
  assert.equal(existsSync(path), false);
});

test("persistLocalJournal uploads the whole local file after a decision", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  writeFileSync(path, '{"decision":"paid"}\n{"decision":"gap"}\n');
  const store = memoryStore();
  await persistLocalJournal(path, store);
  assert.equal(await store.download(), '{"decision":"paid"}\n{"decision":"gap"}\n');
});

test("persistLocalJournal throws when the upload fails", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  writeFileSync(path, '{"decision":"paid"}\n');
  const store = {
    async download(): Promise<string | null> {
      return null;
    },
    async upload(): Promise<void> {
      throw new Error("journal store: upload failed status=500");
    },
  };
  await assert.rejects(() => persistLocalJournal(path, store), /upload failed/);
});

test("gcsStore download returns null on 404 and the body on 200", async () => {
  const calls: string[] = [];
  const store = gcsStore(
    { bucket: "b", object: "decisions.jsonl" },
    {
      token: async () => "tok",
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("missing.jsonl")) {
          return new Response("no", { status: 404, statusText: "Not Found" });
        }
        return new Response('{"decision":"paid"}\n', { status: 200 });
      },
    },
  );
  const missing = gcsStore(
    { bucket: "b", object: "missing.jsonl" },
    {
      token: async () => "tok",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("no", { status: 404, statusText: "Not Found" });
      },
    },
  );
  assert.equal(await missing.download(), null);
  assert.equal(await store.download(), '{"decision":"paid"}\n');
  assert.equal(calls.some((u) => u.includes("/b/b/o/") && u.includes("alt=media")), true);
});

test("gcsStore download throws on a server error so a run cannot start from an empty journal", async () => {
  const store = gcsStore(
    { bucket: "b", object: "decisions.jsonl" },
    {
      token: async () => "tok",
      fetch: async () => new Response("boom", { status: 503, statusText: "Service Unavailable" }),
    },
  );
  await assert.rejects(() => store.download(), /download failed status=503/);
});

test("gcsStore updatedAt reads the object updated field from metadata, not a local file", async () => {
  const store = gcsStore(
    { bucket: "b", object: "decisions.jsonl" },
    {
      token: async () => "tok",
      fetch: async (input) => {
        const url = String(input);
        assert.equal(url.includes("alt=media"), false);
        return new Response(JSON.stringify({ updated: "2026-09-21T00:00:00.000Z" }), { status: 200 });
      },
    },
  );
  const stamp = await store.updatedAt?.();
  assert.equal(stamp?.toISOString(), "2026-09-21T00:00:00.000Z");
});

test("gcsStore updatedAt is null when the object is missing", async () => {
  const store = gcsStore(
    { bucket: "b", object: "missing.jsonl" },
    {
      token: async () => "tok",
      fetch: async () => new Response("no", { status: 404, statusText: "Not Found" }),
    },
  );
  assert.equal(await store.updatedAt?.(), null);
});

test("persistRecordedDecision throws a line that names the decision it could not record", async () => {
  const dir = tmpDir();
  const path = join(dir, "decisions.jsonl");
  writeFileSync(path, '{"decision":"paid","nonce":"1","signature":"sig"}\n');
  const store = {
    async download(): Promise<string | null> {
      return "";
    },
    async upload(): Promise<void> {
      throw new Error("journal store: upload failed status=500");
    },
  };
  await assert.rejects(
    () => persistRecordedDecision(path, store, { decision: "paid", nonce: "1", signature: "sig" }),
    /could not record paid nonce=1 sig=sig/,
  );
});

test("gcsStore upload sends the whole body as a media insert", async () => {
  let posted = "";
  let postedUrl = "";
  const store = gcsStore(
    { bucket: "b", object: "path/decisions.jsonl" },
    {
      token: async () => "tok",
      fetch: async (input, init) => {
        postedUrl = String(input);
        posted = String(init?.body ?? "");
        assert.equal(init?.method, "POST");
        return new Response("{}", { status: 200 });
      },
    },
  );
  await store.upload('{"decision":"paid"}\n');
  assert.equal(posted, '{"decision":"paid"}\n');
  assert.match(postedUrl, /upload\/storage\/v1\/b\/b\/o/);
  assert.match(postedUrl, /uploadType=media/);
  assert.match(postedUrl, /name=path%2Fdecisions\.jsonl/);
});
