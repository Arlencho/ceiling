import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'buffer';

import { KIND_REFUSED } from './constants';
import { decodeEventsFromLogs } from './events';

// Devnet refusal on mandate AL7uNcQvFbvttwoaHmo23B4AiFi2FvNm963egKuFuU5q.
// Signature EfxjSUs2Z9sVpztPnXF54rVa4jG8QEkvBxFBadTwvSWpXAMkJFbixdK5ztHJrPoR1U9rk1Y3Myvp6uAYe34crsd.
// The Program data payload is 65 bytes and the u64 at offset 57 is 300000.
const REFUSED_LINE =
  'Program data: 5jGF0Go+aqmKnwXesECFqx2ayX1miaRMTVINs+HNVSAqkrHzZi0GZOCTBAAAAAAAAgAAAAAAAAAF4JMEAAAAAAA=';

test('a real 65-byte Refused event reports the suggested override', () => {
  const raw = Buffer.from(REFUSED_LINE.slice('Program data: '.length), 'base64');
  assert.equal(raw.length, 65);
  const events = decodeEventsFromLogs(
    'EfxjSUs2Z9sVpztPnXF54rVa4jG8QEkvBxFBadTwvSWpXAMkJFbixdK5ztHJrPoR1U9rk1Y3Myvp6uAYe34crsd',
    [REFUSED_LINE],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, KIND_REFUSED);
  assert.equal(events[0]?.reason, 5);
  assert.equal(events[0]?.amount, 300_000n);
  assert.equal(events[0]?.nonce, 2n);
  assert.equal(events[0]?.suggestedOverride, 300_000n);
});
