import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal") as {
  generate(text: string, options: { small?: boolean }, callback: (code: string) => void): void;
};

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
