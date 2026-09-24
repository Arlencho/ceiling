import { create } from 'qrcode';

const QUIET_ZONE = 4;

export type QrGrid = {
  size: number;
  dark(row: number, col: number): boolean;
};

/** Modules for `text`, including the quiet zone a scanner expects. */
export function qrModules(text: string): QrGrid {
  const symbol = create(text, { errorCorrectionLevel: 'M' });
  const inner = symbol.modules.size;
  const size = inner + QUIET_ZONE * 2;
  return {
    size,
    dark(row, col) {
      const r = row - QUIET_ZONE;
      const c = col - QUIET_ZONE;
      if (r < 0 || c < 0 || r >= inner || c >= inner) {
        return false;
      }
      return symbol.modules.get(r, c) === 1;
    },
  };
}
