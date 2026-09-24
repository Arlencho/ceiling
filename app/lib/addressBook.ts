import { Buffer } from 'buffer';

import { canonicalAddress } from './ruleRequest';
import type { WalletStore } from './wallet';

export const ADDRESS_BOOK_KEY = 'veto.addressBook';
const MAX_BYTES = 1800;

export function parseAddressBook(raw: string | null): Record<string, string> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const book: Record<string, string> = {};
    for (const [address, name] of Object.entries(parsed)) {
      const key = canonicalAddress(address);
      if (!key || typeof name !== 'string') {
        continue;
      }
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        continue;
      }
      book[key] = trimmed;
    }
    return book;
  } catch {
    return {};
  }
}

export function withSavedName(
  book: Record<string, string>,
  address: string,
  name: string,
): Record<string, string> {
  const key = canonicalAddress(address);
  if (!key) {
    throw new Error('Save a name for a full address.');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Enter a name.');
  }
  if (Array.from(trimmed).length > 40) {
    throw new Error('Use a shorter name.');
  }
  const next = { ...book, [key]: trimmed };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_BYTES) {
    throw new Error('This phone has no room for another saved name.');
  }
  return next;
}

export async function loadAddressBook(store: WalletStore): Promise<Record<string, string>> {
  return parseAddressBook(await store.getItem(ADDRESS_BOOK_KEY));
}

export async function saveAddressBook(store: WalletStore, book: Record<string, string>): Promise<void> {
  await store.setItem(ADDRESS_BOOK_KEY, JSON.stringify(book));
}
