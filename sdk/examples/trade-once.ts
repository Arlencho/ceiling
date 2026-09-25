import { assertDevnet, assertPoolEnvironment } from "./hacked-agent.js";
import { fetchTradeRule } from "../src/index.js";
import { loadDemo, mainIfDirect, parseTradeArgs, runTradeOnce } from "./trade-demo.js";

mainIfDirect(import.meta.url, async () => {
  const args = parseTradeArgs(process.argv.slice(2));
  const veto = await loadDemo(args);
  if (process.env.VETO_TRADE_DEMO_DEVNET === "1") {
    await assertDevnet(veto);
    assertPoolEnvironment(await fetchTradeRule(veto.connection, veto.tradeRule!, veto.programId));
  }
  await runTradeOnce(veto, args.amount);
});
