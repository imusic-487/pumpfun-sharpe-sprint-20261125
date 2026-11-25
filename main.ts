// Pump.fun Sharpe Sprint — cleanest paper bot wins.
//
// Entrypoint: wires the strategy in strategy.ts into the kit's
// agent-fun/replay/v2 shim (vendor/makefun-bot.ts). The bot trades paper
// money on a 6-hour pump.fun forward replay; places go by hourly Sharpe
// ratio, so the strategy buys only clean fresh launches, sizes small, and
// exits mechanically. See strategy.ts for the full behaviour.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
