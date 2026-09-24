declare module 'qrcode' {
  export type QrSymbol = {
    modules: {
      size: number;
      get(row: number, col: number): number;
    };
  };

  export function create(
    data: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
  ): QrSymbol;
}

declare module 'pngjs' {
  export const PNG: {
    sync: {
      read(buffer: Buffer): { width: number; height: number; data: Buffer };
    };
  };
}
