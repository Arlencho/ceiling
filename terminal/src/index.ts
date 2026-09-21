import { EnergySpotFeed } from "../../watcher/src/feed.js";
import { loadTerminalConfig } from "./config.js";
import { createTerminalServer } from "./server.js";
import { buildState, quoteResponse } from "./state.js";

const cmd = process.argv[2] ?? "serve";

async function main(): Promise<number> {
  const cfg = loadTerminalConfig();

  if (cmd === "quote") {
    const state = await buildState({
      feed: new EnergySpotFeed(),
      at: new Date(),
      kwhMilli: cfg.kwhMilli,
      mintDecimals: cfg.mintDecimals,
    });
    const { status, body } = quoteResponse(state, cfg);
    console.log(JSON.stringify(body, null, 2));
    return status === 200 ? 0 : 1;
  }

  if (cmd === "serve") {
    const server = createTerminalServer({ cfg });
    server.listen(cfg.port, () => {
      console.log(`merchant terminal on http://127.0.0.1:${String(cfg.port)}`);
      console.log(`rpc: ${cfg.rpc}`);
      console.log(`merchant token account: ${cfg.merchantTokenAccount}`);
      console.log("the price is public and verifiable at the source URL shown on the page;");
      console.log("this terminal is a demo counterparty, not a real charge point.");
    });
    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return 0;
  }

  console.error(`usage: node src/index.ts [serve|quote]`);
  return 2;
}

process.exitCode = await main();
