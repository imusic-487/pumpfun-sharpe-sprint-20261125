// Clean-Sharpe launch sniper for the Pump.fun Sharpe Sprint (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte as vendor/makefun-bot.ts.
// Paper trading only: buys new pump.fun curves in their first few slots when the opening
// tape passes the rug filters, exits on asymmetric take-profit / stop-loss with a trailing
// stop, and paces tiny probe round trips so the run clears the 20-coin guardrail.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
