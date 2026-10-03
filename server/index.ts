import { createApp } from "./app";
import { setupVite, serveStatic, log } from "./vite";
import { startEpisodeScheduler } from "./episode-scheduler";
import { initializeRecommendationScheduler } from "./recommendation-scheduler";
import { initNewReleasesScheduler } from "./new-releases-scheduler";
import { ensureTvmazeGateSeeded } from "./tvmaze/pace";

(async () => {
  const { app, server } = await createApp();

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Seed the TVMaze pace-gate rows before serving: the acquire path
  // assumes the pace row and slot rows exist (db:push creates the tables).
  await ensureTvmazeGateSeeded();

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });

  startEpisodeScheduler();
  initializeRecommendationScheduler();
  initNewReleasesScheduler();
})();
