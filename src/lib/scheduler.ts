import { refreshAll } from "./feeds";
import { getSettings } from "./settings";

const g = globalThis as unknown as {
  __schedulerStarted?: boolean;
  __stitchRefreshAll?: () => Promise<number>;
};

/** Background refresh loop. Re-reads the interval each tick so settings changes apply without a restart. */
export function startScheduler() {
  if (g.__schedulerStarted || process.env.DISABLE_SCHEDULER === "1") return;
  g.__schedulerStarted = true;

  const tick = async () => {
    try {
      // In dev the scheduler (started from instrumentation) is never hot-reloaded, so prefer the
      // refreshAll registered by the most recently loaded copy of feeds.ts over our own import.
      const added = await (g.__stitchRefreshAll ?? refreshAll)();
      if (added) console.log(`[stitch] refresh: ${added} new articles`);
    } catch (e) {
      console.error("[stitch] refresh failed", e);
    }
    const minutes = Math.max(5, getSettings().refreshIntervalMinutes || 30);
    setTimeout(tick, minutes * 60000).unref?.();
  };
  setTimeout(tick, 15000).unref?.();
}
