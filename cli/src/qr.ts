import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal") as {
  generate(text: string, options: { small?: boolean }, callback: (code: string) => void): void;
};

type QrSymbol = {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};

const QRCode = require("qrcode-terminal/vendor/QRCode") as new (typeNumber: number, level: number) => QrSymbol;
const qrLevels = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { M: number };

export function renderQr(text: string): string {
  let rendered = "";
  qrcode.generate(text, { small: true }, (code) => {
    rendered = code;
  });
  if (rendered.trim() === "") {
    throw new Error("QR renderer returned nothing.");
  }
  return rendered;
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const QUIET = 4;

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c ^= data[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      const bit = c & 1;
      c = (c >>> 1) >>> 0;
      if (bit !== 0) c = (c ^ 0xedb88320) >>> 0;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i += 1) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** PNG of the same QR encoder the terminal printer uses, with a quiet zone a phone can scan. */
export function renderQrPng(text: string): Buffer {
  const symbol = new QRCode(-1, qrLevels.M);
  symbol.addData(text);
  symbol.make();
  const count = symbol.getModuleCount();
  const grid = count + QUIET * 2;
  const scale = 4;
  const size = grid * scale;
  const stride = size + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    const moduleRow = Math.floor(y / scale) - QUIET;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const moduleCol = Math.floor(x / scale) - QUIET;
      const dark =
        moduleRow >= 0 && moduleCol >= 0 && moduleRow < count && moduleCol < count && symbol.isDark(moduleRow, moduleCol);
      raw[row + 1 + x] = dark ? 0 : 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8;
  const bytes = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
  return bytes;
}
