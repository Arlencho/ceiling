import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

type NamedDisc = { name: string; discriminator: number[] };

type IdlFile = {
  address: string;
  instructions: NamedDisc[];
  accounts: NamedDisc[];
  events: NamedDisc[];
};

function loadIdl(): IdlFile {
  const path = fileURLToPath(new URL("../idl/veto.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as IdlFile;
}

function discriminator(list: readonly NamedDisc[], name: string): Buffer {
  const found = list.find((item) => item.name === name);
  if (!found) throw new Error(`idl: missing ${name}`);
  return Buffer.from(found.discriminator);
}

const idl = loadIdl();

/** Program id recorded in the bundled IDL (`indexer/idl/veto.json`). */
export const PROGRAM_ID = new PublicKey(idl.address);

export const CHARGE_DISCRIMINATOR = discriminator(idl.instructions, "charge");
export const MANDATE_DISCRIMINATOR = discriminator(idl.accounts, "Mandate");
export const LEDGER_DISCRIMINATOR = discriminator(idl.accounts, "Ledger");
export const PAID_EVENT_DISCRIMINATOR = discriminator(idl.events, "Paid");
export const REFUSED_EVENT_DISCRIMINATOR = discriminator(idl.events, "Refused");
