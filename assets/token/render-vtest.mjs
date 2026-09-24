#!/usr/bin/env node
// Draw assets/token/vtest.png: a 256x256 letter V.
// Bone #EDE6D6 on dark green #0F1A16.
//
//   node assets/token/render-vtest.mjs
//
// Commit the PNG this writes. Do not edit the PNG by hand.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const SIZE = 256;
const BG = [0x0f, 0x1a, 0x16];
const FG = [0xed, 0xe6, 0xd6];
const LEFT = [68, 58, 128, 198];
const RIGHT = [188, 58, 128, 198];
const HALF = 18;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function same(actual, expected) {
  return actual[0] === expected[0] && actual[1] === expected[1] && actual[2] === expected[2];
}

function dist(px, py, seg) {
  const [x1, y1, x2, y2] = seg;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ex = px - (x1 + t * dx);
  const ey = py - (y1 + t * dy);
  return Math.hypot(ex, ey);
}

function pixel(x, y) {
  const on = dist(x, y, LEFT) <= HALF || dist(x, y, RIGHT) <= HALF;
  return on ? FG : BG;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, "ascii");
  const body = Buffer.concat([tag, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encode() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
  for (let y = 0; y < SIZE; y += 1) {
    const row = y * (1 + SIZE * 3);
    raw[row] = 0;
    for (let x = 0; x < SIZE; x += 1) {
      const [r, g, b] = pixel(x, y);
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function decode(buf) {
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail("png signature mismatch");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + len;
  }
  if (width !== SIZE || height !== SIZE) fail(`png is ${width}x${height}, expected ${SIZE}x${SIZE}`);
  return inflateSync(Buffer.concat(idat));
}

function rawPixel(raw, x, y) {
  const i = y * (1 + SIZE * 3) + 1 + x * 3;
  return [raw[i], raw[i + 1], raw[i + 2]];
}

function expect(raw, x, y, color, label) {
  const actual = rawPixel(raw, x, y);
  if (!same(actual, color)) {
    fail(`${label} at ${x},${y} is ${actual.join(",")}, expected ${color.join(",")}`);
  }
}

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, "vtest.png");
mkdirSync(dir, { recursive: true });
const bytes = encode();
const raw = decode(bytes);
expect(raw, 0, 0, BG, "corner");
expect(raw, 128, 40, BG, "open top");
expect(raw, 68, 58, FG, "left arm");
expect(raw, 188, 58, FG, "right arm");
expect(raw, 128, 198, FG, "bottom of the V");
writeFileSync(out, bytes);
const reread = decode(readFileSync(out));
expect(reread, 68, 58, FG, "written left arm");
expect(reread, 0, 0, BG, "written corner");
console.log(`wrote assets/token/vtest.png (${SIZE}x${SIZE}, ${bytes.length} bytes)`);
