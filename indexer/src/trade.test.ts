import { test } from "node:test";
import assert from "node:assert/strict";
import { tradeFixture } from "../fixtures/trade.js";
import { decisionsFromTx, decodeEventBytes } from "./events.js";
import { fetchDecisionHistory } from "./history.js";
for (const refused of [false, true]) {
  test(`history lists a ${refused ? "refused trade" : "traded decision"} under its rule`, async () => {
    const f = tradeFixture(refused);
    const rows = decisionsFromTx(f.view, String(f.program), String(f.rule));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, refused ? "refused" : "traded");
    assert.equal((rows[0] as any).rule, String(f.rule));
    assert.equal((rows[0] as any).amountOut, refused ? 0n : 150n);
    const history = await fetchDecisionHistory({
      rpcUrl: "http://fixture",
      programId: String(f.program),
      mandate: String(f.rule),
      connection: f.conn,
    });
    assert.equal(history.decisions.length, 1);
    assert.equal(
      decisionsFromTx({ ...f.view, err: {} }, String(f.program)).length,
      0,
    );
    assert.equal(
      decodeEventBytes(f.event.subarray(0, f.event.length - 1)),
      null,
    );
    assert.equal(decisionsFromTx(f.view, String(f.pool)).length, 0);
  });
}
