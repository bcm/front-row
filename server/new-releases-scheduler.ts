import cron from "node-cron";
import { refreshNewReleases } from "./new-releases-service";

export function initNewReleasesScheduler() {
  cron.schedule(
    "0 21 * * 5",
    async () => {
      console.log("[NEW_RELEASES_SCHEDULER] Starting Friday night refresh...");
      const startTime = Date.now();

      try {
        const shows = await refreshNewReleases();
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(
          `[NEW_RELEASES_SCHEDULER] Refresh complete in ${duration}s - Found ${shows.length} new releases`
        );
      } catch (error) {
        console.error("[NEW_RELEASES_SCHEDULER] Error during refresh:", error);
      }
    },
    {
      timezone: "America/New_York",
    }
  );

  console.log(
    "[NEW_RELEASES_SCHEDULER] Initialized - will run every Friday at 9:00 PM Eastern Time"
  );
}
