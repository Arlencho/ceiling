import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CLOSE_TRADE_RULE_DISC,
  GRANT_TRADE_OVERRIDE_DISC,
  OPEN_TRADE_RULE_DISC,
  REVOKE_TRADE_RULE_DISC,
  TRADE_IX_DISC,
  TRADE_LEDGER_DISCRIMINATOR,
  TRADE_REFUSED_EVENT_DISC,
  TRADE_RULE_DISCRIMINATOR,
  TRADED_EVENT_DISC,
} from './constants';

const NAMED = [
  ['global:open_trade_rule', OPEN_TRADE_RULE_DISC],
  ['global:trade', TRADE_IX_DISC],
  ['global:grant_trade_override', GRANT_TRADE_OVERRIDE_DISC],
  ['global:revoke_trade_rule', REVOKE_TRADE_RULE_DISC],
  ['global:close_trade_rule', CLOSE_TRADE_RULE_DISC],
  ['account:TradeRule', TRADE_RULE_DISCRIMINATOR],
  ['account:TradeLedger', TRADE_LEDGER_DISCRIMINATOR],
  ['event:Traded', TRADED_EVENT_DISC],
  ['event:TradeRefused', TRADE_REFUSED_EVENT_DISC],
] as const;

test('trade discriminators are the first 8 bytes of sha256', () => {
  for (const [name, disc] of NAMED) {
    const hash = createHash('sha256').update(name).digest();
    assert.deepEqual(Buffer.from(disc), hash.subarray(0, 8), name);
  }
});
