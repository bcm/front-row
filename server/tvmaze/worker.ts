// Scheduled drain worker for the TVMaze pace queue (issue #5).
// Same relay shape as the planned outbox drain (#12): table + scheduled
// worker. Wired in server/index.ts alongside the other schedulers.

import cron from "node-cron";
import { drainTvmazeQueue, requeueStuckRows, pruneCompletedRows } from "./queue";

export function startTvmazeDrainWorker(): void {
  // Drain tick: claim queued rows and admit them through the pace gate.
  cron.schedule("* * * * * *", async () => {
    try {
      await drainTvmazeQueue();
    } catch (error) {
      console.error("[TVMAZE-QUEUE] drain tick failed:", error);
    }
  });
  // Maintenance tick: recover rows orphaned by crashed workers, prune old
  // completions so the table doesn't grow forever.
  cron.schedule("*/5 * * * *", async () => {
    try {
      await requeueStuckRows();
      await pruneCompletedRows();
    } catch (error) {
      console.error("[TVMAZE-QUEUE] maintenance tick failed:", error);
    }
  });
  console.log("[TVMAZE-QUEUE] drain worker started (1s drain tick, 5m maintenance tick)");
}
