import { Buffer } from 'buffer';

import { qrModules } from './qrMatrix';
import {
  formatWeekdayDateYear,
  networkBadge,
  type RuleSnapshot,
} from './grade';

export type TrackRecord = {
  agentName: string;
  ruleAddress: string;
  shortAddress: string;
  cluster: string;
  badge: string;
  kicker: string;
  title: string;
  rangeLine: string;
  lead: string;
  follow: string;
  paid: number;
  refused: number;
  allowances: number;
  spentLabel: string;
  capLabel: string;
  remainingLabel: string;
  ended: boolean;
  days: number | null;
  qrText: string;
};

export type ImageLayout = {
  width: number;
  height: number;
  badge: { x: number; y: number; scale: number; text: string };
  qr: { x: number; y: number; scale: number; size: number };
};

const WIDTH = 640;
const SCALE = 2;
const GLYPH_W = 5;
const GLYPH_H = 7;
const PAD = 28;

const FONT_SRC = `
A .###. #...# #...# ##### #...# #...# #...#
B ####. #...# #...# ####. #...# #...# ####.
C .###. #...# #.... #.... #.... #...# .###.
D ####. #...# #...# #...# #...# #...# ####.
E ##### #.... #.... ####. #.... #.... #####
F ##### #.... #.... ####. #.... #.... #....
G .###. #...# #.... #.### #...# #...# .###.
H #...# #...# #...# ##### #...# #...# #...#
I ..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
J ....# ....# ....# ....# #...# #...# .###.
K #...# #..#. #.#.. ##... #.#.. #..#. #...#
L #.... #.... #.... #.... #.... #.... #####
M #...# ##.## #.#.# #...# #...# #...# #...#
N #...# ##..# #.#.# #..## #...# #...# #...#
O .###. #...# #...# #...# #...# #...# .###.
P ####. #...# #...# ####. #.... #.... #....
Q .###. #...# #...# #...# #.#.# #..#. .##.#
R ####. #...# #...# ####. #.#.. #..#. #...#
S .###. #.... #.... .###. ....# ....# .###.
T ##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
U #...# #...# #...# #...# #...# #...# .###.
V #...# #...# #...# #...# #...# .#.#. ..#..
W #...# #...# #...# #.#.# #.#.# ##.## #...#
X #...# #...# .#.#. ..#.. .#.#. #...# #...#
Y #...# #...# .#.#. ..#.. ..#.. ..#.. ..#..
Z ##### ....# ...#. ..#.. .#... #.... #####
0 .###. #..## #.#.# ##..# #...# #...# .###.
1 ..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.
2 .###. #...# ....# ..##. .#... #.... #####
3 .###. #...# ....# ..##. ....# #...# .###.
4 ...#. ..##. .#.#. #..#. ##### ...#. ...#.
5 ##### #.... ####. ....# ....# #...# .###.
6 .###. #.... ####. #...# #...# #...# .###.
7 ##### ....# ...#. ..#.. .#... .#... .#...
8 .###. #...# .###. .###. #...# #...# .###.
9 .###. #...# #...# .#### ....# ....# .###.
. ..... ..... ..... ..... ..... ..#.. ..#..
, ..... ..... ..... ..... ..#.. ..#.. .#...
: ..... ..#.. ..#.. ..... ..#.. ..#.. .....
- ..... ..... ..... .###. ..... ..... .....
`.trim();

const FONT = new Map<string, boolean[][]>();
for (const line of FONT_SRC.split('\n')) {
  const parts = line.split(' ');
  const ch = parts[0];
  if (!ch || parts.length !== 8) {
    continue;
  }
  FONT.set(
    ch,
    parts.slice(1).map((row) => row.split('').map((cell) => cell === '#')),
  );
}

export function glyphOn(ch: string, row: number, col: number): boolean {
  const glyph = FONT.get(ch.toUpperCase());
  if (!glyph) {
    return row === 0 || row === GLYPH_H - 1 || col === 0 || col === GLYPH_W - 1;
  }
  return glyph[row]?.[col] === true;
}

function paintText(
  raw: Uint8Array,
  stride: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: [number, number, number],
): void {
  let cursor = x;
  const advance = (GLYPH_W + 1) * scale;
  for (const ch of text.toUpperCase()) {
    if (ch === ' ') {
      cursor += advance;
      continue;
    }
    for (let row = 0; row < GLYPH_H; row += 1) {
      for (let col = 0; col < GLYPH_W; col += 1) {
        if (!glyphOn(ch, row, col)) {
          continue;
        }
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = cursor + col * scale + dx;
            const py = y + row * scale + dy;
            if (px < 0 || py < 0 || px >= WIDTH) {
              continue;
            }
            const at = py * stride + 1 + px * 3;
            raw[at] = color[0];
            raw[at + 1] = color[1];
            raw[at + 2] = color[2];
          }
        }
      }
    }
    cursor += advance;
  }
}

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

function fillRect(
  raw: Uint8Array,
  stride: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number],
): void {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      if (px < 0 || py < 0 || px >= WIDTH) {
        continue;
      }
      const at = py * stride + 1 + px * 3;
      raw[at] = color[0];
      raw[at + 1] = color[1];
      raw[at + 2] = color[2];
    }
  }
}

const FOREST: [number, number, number] = [15, 26, 22];
const BRASS: [number, number, number] = [201, 162, 77];
const BONE: [number, number, number] = [237, 230, 214];
const AMBER: [number, number, number] = [227, 199, 126];

function wrap(text: string, max: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > max && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

export function trackRecordFor(
  rule: RuleSnapshot,
  agentName: string,
  cluster: string,
  nowSec: bigint,
  ended: boolean,
): TrackRecord {
  const outside = rule.classified.refused.length;
  const paid = rule.classified.paidInside.length;
  const allowances = rule.classified.allowances.length;
  const days = rule.totalDays != null && ended ? rule.totalDays : rule.day;
  const lead =
    days == null
      ? `Asked outside its rule ${outside} times.`
      : `Asked outside its rule ${outside} times in ${days} days.`;
  let follow = 'None were outside the rule.';
  if (outside > 0 && allowances === 0) {
    follow = 'Refused every time.';
  } else if (allowances === 1) {
    follow = 'You allowed one after a refusal.';
  } else if (allowances > 1) {
    follow = `You allowed ${allowances} after a refusal.`;
  }
  const start = rule.startedAt;
  const end = ended ? rule.expiresAt : nowSec;
  const rangeLine =
    start == null
      ? `Through ${formatWeekdayDateYear(end)}. One rule, one account.`
      : `${formatWeekdayDateYear(start)} to ${formatWeekdayDateYear(end)}. ${days ?? ''} days. One rule, one account.`
  const title = ended
    ? days == null
      ? 'On one card.'
      : `${days} days, on one card.`
    : days == null
      ? 'On one card.'
      : `${days} days so far, on one card.`;
  const kicker = ended ? `${agentName}, rule complete` : `${agentName}, ${rule.dayLabel}`;
  return {
    agentName,
    ruleAddress: rule.address,
    shortAddress: rule.shortAddress,
    cluster,
    badge: networkBadge(cluster, 'card'),
    kicker,
    title,
    rangeLine: rangeLine.replace('  ', ' ').trim(),
    lead,
    follow,
    paid,
    refused: outside,
    allowances,
    spentLabel: rule.spentLabel,
    capLabel: rule.capLabel,
    remainingLabel: rule.remainingLabel,
    ended,
    days,
    qrText: rule.address,
  };
}

export function trackRecordLines(record: TrackRecord): string[] {
  const left = record.ended
    ? `${record.remainingLabel} returned to the owner.`
    : `${record.remainingLabel} still available.`;
  return [
    record.badge,
    'Veto track record',
    record.kicker,
    record.title,
    record.rangeLine,
    record.lead,
    record.follow,
    `${record.paid} payments paid, all within the rule`,
    `${record.refused} payments refused, 0 moved`,
    `${record.allowances} allowed by the owner after a refusal`,
    `${record.spentLabel} of ${record.capLabel} spent. ${left}`,
    `Rule ${record.ruleAddress}`,
    'Check every line on the blockchain.',
  ];
}

export function trackRecordText(record: TrackRecord, checkUrl: string): string {
  return [...trackRecordLines(record), checkUrl].join('\n');
}

export function ruleCheckUrl(address: string, cluster: string, rpcUrl: string): string {
  if (cluster === 'devnet' || cluster === 'testnet' || cluster === 'mainnet-beta') {
    return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
  }
  return `https://explorer.solana.com/address/${address}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
}

export function trackRecordLayout(record: TrackRecord): ImageLayout {
  const grid = qrModules(record.qrText);
  const qrScale = Math.max(3, Math.min(6, Math.floor(200 / grid.size)));
  const qrSize = grid.size * qrScale;
  const lines = trackRecordLines(record).flatMap((line) => wrap(line, 42));
  const lineH = GLYPH_H * SCALE + 8;
  const textBottom = PAD + lines.length * lineH;
  const height = Math.max(880, textBottom + qrSize + PAD * 2);
  return {
    width: WIDTH,
    height,
    badge: { x: PAD, y: PAD, scale: SCALE, text: record.badge },
    qr: { x: PAD, y: height - PAD - qrSize, scale: qrScale, size: qrSize },
  };
}

export function trackRecordPng(record: TrackRecord): Uint8Array {
  const layout = trackRecordLayout(record);
  const height = layout.height;
  const stride = WIDTH * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = FOREST[0];
      raw[at + 1] = FOREST[1];
      raw[at + 2] = FOREST[2];
    }
  }
  fillRect(raw, stride, 8, 8, WIDTH - 16, height - 16, BRASS);
  fillRect(raw, stride, 12, 12, WIDTH - 24, height - 24, FOREST);

  const lines = trackRecordLines(record).flatMap((line) => wrap(line, 42));
  const lineH = GLYPH_H * SCALE + 8;
  lines.forEach((line, index) => {
    const color = index === 0 ? AMBER : BONE;
    paintText(raw, stride, line, PAD, PAD + index * lineH, SCALE, color);
  });

  const grid = qrModules(record.qrText);
  const { x, y, scale } = layout.qr;
  fillRect(raw, stride, x - 6, y - 6, grid.size * scale + 12, grid.size * scale + 12, BONE);
  for (let row = 0; row < grid.size; row += 1) {
    for (let col = 0; col < grid.size; col += 1) {
      if (!grid.dark(row, col)) {
        continue;
      }
      fillRect(raw, stride, x + col * scale, y + row * scale, scale, scale, FOREST);
    }
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, WIDTH);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const comment = Buffer.from(`Comment\0${trackRecordLines(record).join('\n')}`, 'latin1');
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('tEXt', comment),
    chunk('IDAT', zlibWrap(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export function pngComment(bytes: Uint8Array): string | null {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(offset);
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const text = Buffer.from(data).toString('latin1');
      const split = text.indexOf('\0');
      return split >= 0 ? text.slice(split + 1) : text;
    }
    if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  return null;
}
