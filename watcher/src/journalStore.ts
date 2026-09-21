import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JournalObjectStore = {
  download(): Promise<string | null>;
  upload(body: string): Promise<void>;
};

export type GsLocation = {
  bucket: string;
  object: string;
};

export type GcsStoreDeps = {
  fetch?: typeof fetch;
  token?: () => Promise<string>;
};

const GS_URI = /^gs:\/\/([^/]+)\/(.+)$/;
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export function parseGsUri(uri: string): GsLocation {
  const match = GS_URI.exec(uri);
  const bucket = match?.[1];
  const object = match?.[2];
  if (bucket === undefined || object === undefined || object.length === 0) {
    throw new Error(`config: VETO_JOURNAL_GCS must be gs://bucket/object, got ${uri}`);
  }
  return { bucket, object };
}

export function memoryStore(initial?: string): JournalObjectStore {
  let body: string | null = initial === undefined ? null : initial;
  return {
    async download() {
      return body;
    },
    async upload(next: string) {
      body = next;
    },
  };
}

async function metadataToken(fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) {
    throw new Error(`journal store: metadata token failed status=${res.status}`);
  }
  const payload = (await res.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("journal store: metadata token missing access_token");
  }
  return payload.access_token;
}

export function gcsStore(location: GsLocation, deps: GcsStoreDeps = {}): JournalObjectStore {
  const fetchFn = deps.fetch ?? fetch;
  const tokenFn = deps.token ?? (() => metadataToken(fetchFn));
  const objectPath = encodeURIComponent(location.object);
  const bucketPath = encodeURIComponent(location.bucket);
  const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucketPath}/o/${objectPath}?alt=media`;
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucketPath}/o?uploadType=media&name=${objectPath}`;

  return {
    async download() {
      const token = await tokenFn();
      const res = await fetchFn(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`journal store: download failed status=${res.status}`);
      }
      return await res.text();
    },
    async upload(body: string) {
      const token = await tokenFn();
      const res = await fetchFn(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`journal store: upload failed status=${res.status}`);
      }
    },
  };
}

export function storeFromGsUri(uri: string | null, deps?: GcsStoreDeps): JournalObjectStore | null {
  if (uri === null) return null;
  return gcsStore(parseGsUri(uri), deps);
}

export async function hydrateLocalJournal(path: string, store: JournalObjectStore): Promise<void> {
  const body = await store.download();
  if (body === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

export async function persistLocalJournal(path: string, store: JournalObjectStore): Promise<void> {
  if (!existsSync(path)) return;
  const body = readFileSync(path, "utf8");
  await store.upload(body);
}
