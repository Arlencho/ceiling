import { Buffer } from 'buffer';

import { qrModules } from './qrMatrix';

const MAX_EDGE = 280;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < data.length; i += 1) {
    s1 = (s1 + data[i]!) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/** Deflate stored blocks. No zlib binding, so the app can draw the PNG itself. */
function deflateStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  do {
    const remaining = data.length - offset;
    const len = Math.min(remaining, 65535);
    const final = offset + len >= data.length;
    const block = new Uint8Array(5 + len);
    block[0] = final ? 0x01 : 0x00;
    block[1] = len & 0xff;
    block[2] = (len >> 8) & 0xff;
    const nlen = len ^ 0xffff;
    block[3] = nlen & 0xff;
    block[4] = (nlen >> 8) & 0xff;
    block.set(data.subarray(offset, offset + len), 5);
    parts.push(block);
    offset += len;
  } while (offset < data.length);
  return concat(parts);
}

function zlibWrap(raw: Uint8Array): Uint8Array {
  const deflated = deflateStored(raw);
  const out = new Uint8Array(2 + deflated.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(deflated, 2);
  const sum = adler32(raw);
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 4, sum);
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i += 1) {
    body[i] = type.charCodeAt(i);
  }
  body.set(data, 4);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

export function qrPng(text: string): { bytes: Uint8Array; size: number } {
  const grid = qrModules(text);
  const scale = Math.max(2, Math.floor(MAX_EDGE / grid.size));
  const size = grid.size * scale;
  const stride = size + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    const moduleRow = Math.floor(y / scale);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x] = grid.dark(moduleRow, Math.floor(x / scale)) ? 0 : 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8;
  const bytes = concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibWrap(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
  return { bytes, size };
}

export function qrPngDataUri(text: string): { uri: string; size: number } {
  const image = qrPng(text);
  return {
    uri: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
    size: image.size,
  };
}
