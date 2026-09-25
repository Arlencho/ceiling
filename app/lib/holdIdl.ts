import { Buffer } from 'buffer';

import idl from '../../sdk/idl/veto.json';

type Named = { name: string; discriminator: number[] };

function disc(list: readonly Named[], name: string): Buffer {
  const found = list.find((item) => item.name === name);
  if (!found) {
    throw new Error(`The program description has no ${name} instruction.`);
  }
  return Buffer.from(found.discriminator);
}

const instructions = idl.instructions as Named[];
const accounts = idl.accounts as Named[];

export const INIT_VAULT_DISC = disc(instructions, 'init_vault');
export const DEPOSIT_DISC = disc(instructions, 'deposit');
export const WITHDRAW_DISC = disc(instructions, 'withdraw');
export const STOP_DISC = disc(instructions, 'stop');
export const FREEZE_DISC = disc(instructions, 'freeze');
export const UNFREEZE_DISC = disc(instructions, 'unfreeze');
export const SKIP_DISC = disc(instructions, 'skip');
export const RECOVER_DISC = disc(instructions, 'recover');
export const HOLD_VAULT_DISC = disc(accounts, 'HoldVault');
export const HOLD_LEDGER_DISC = disc(accounts, 'HoldLedger');
