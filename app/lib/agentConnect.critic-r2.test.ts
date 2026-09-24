// Critic round 2 for PR 203 (feat/connect-agent). Pins the block the rule
// screen copied for devnet mandate 3 on 50ea5dd through the SDK loader and the
// app parser, and the Refused event of the charge the example made from that
// block (signature 4FMSmn1R..., slot 503221233) through the app and SDK
// decoders. The override decode is red on 058a32c, where events.ts asked for
// 73 bytes and reported 0 for every real 65-byte event.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { agentChargeConfigJson, parseAgentChargeConfig } from './agentConnect';
import { KIND_REFUSED } from './constants';
import { decodeEventsFromLogs } from './events';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

// Copied from the rule screen for mandate 3 on devnet (round 2 devnet run).
const DEVNET_BLOCK =
  '{"mandate":"GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG","programId":"3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV","mint":"2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU","mintDecimals":6,"sourceTokenAccount":"FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE","payeeTokenAccount":"2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F","agent":"6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w","cluster":"devnet","rpcUrl":"https://api.devnet.solana.com"}';

// The one Program data line of that charge, refused 5 at 10000001 base units.
const REFUSED_SIGNATURE =
  '4FMSmn1R3RxUpFJUYyinN4n7MH4TCrGUnuq2KTUGjZ5Ju9GdTxr1FehhEGDWEW2SrT6tPn14TmCqNvJMGqxN8Ekn';
const REFUSED_LINE =
  'Program data: 5jGF0Go+aqnmSQI79NBewazyJ3ux02Rj+lo7Fxze003Dm5QzShqIh4GWmAAAAAAAAQAAAAAAAAAFgZaYAAAAAAA=';

test('critic r2: the devnet block loads through the SDK loader and the app parser to the same object', async () => {
  const sdk = (await import('../../sdk/src/config')) as {
    loadAgentConfig: (json: string | unknown) => Record<string, unknown>;
  };
  const fromText = sdk.loadAgentConfig(DEVNET_BLOCK);
  const fromObject = sdk.loadAgentConfig(JSON.parse(DEVNET_BLOCK));
  const app = parseAgentChargeConfig(JSON.parse(DEVNET_BLOCK));
  assert.deepEqual(fromText, app);
  assert.deepEqual(fromObject, app);
  assert.equal(agentChargeConfigJson(app), DEVNET_BLOCK, 'the block re-serialises byte for byte');
  assert.equal(app.payeeTokenAccount, '2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F');
});

test('critic r2: the Refused event of the charge made from that block decodes the same in the app and the SDK', async () => {
  const raw = Buffer.from(REFUSED_LINE.slice('Program data: '.length), 'base64');
  assert.equal(raw.length, 65, 'a Refused event is 65 bytes, so 73 is never reached');
  assert.equal(
    new PublicKey(raw.subarray(8, 40)).toBase58(),
    'GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG',
    'the event names mandate 3',
  );
  const app = decodeEventsFromLogs(REFUSED_SIGNATURE, [REFUSED_LINE]);
  assert.equal(app.length, 1);
  assert.equal(app[0]?.kind, KIND_REFUSED);
  assert.equal(app[0]?.reason, 5);
  assert.equal(app[0]?.amount, 10_000_001n);
  assert.equal(app[0]?.nonce, 1n);
  assert.equal(app[0]?.suggestedOverride, 10_000_001n, 'the app reports the override the program suggested');

  const sdk = (await import('../../sdk/src/events')) as {
    decodeEventsFromLogs: (logs: readonly string[]) => { kind: string; reason: number; amount: bigint; nonce: bigint; suggestedOverride: bigint }[];
  };
  const viaSdk = sdk.decodeEventsFromLogs([REFUSED_LINE]);
  assert.equal(viaSdk.length, 1);
  assert.equal(viaSdk[0]?.kind, 'refused');
  assert.equal(viaSdk[0]?.suggestedOverride, app[0]?.suggestedOverride);
  assert.equal(viaSdk[0]?.amount, app[0]?.amount);
  assert.equal(viaSdk[0]?.nonce, app[0]?.nonce);
});
