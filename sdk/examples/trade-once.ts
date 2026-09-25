import { assertDevnet, assertPoolEnvironment } from "./hacked-agent.js";
import { fetchTradeRule, type VetoAgent } from "../src/index.js";
import { assertExpected, loadDemo, mainIfDirect, parseTradeArgs, runTradeOnce } from "./trade-demo.js";

export async function runHonestTrade(veto: VetoAgent, amount: bigint) {
  await assertDevnet(veto);
  if (process.env.VETO_TRADE_DEMO_DEVNET === "1") {
    assertPoolEnvironment(await fetchTradeRule(veto.connection, veto.tradeRule!, veto.programId));
  }
  const result = await runTradeOnce(veto, amount);
  assertExpected(result, 0);
  return result;
}

mainIfDirect(import.meta.url, async () => {
  const args = parseTradeArgs(process.argv.slice(2));
  await runHonestTrade(await loadDemo(args), args.amount);
});
