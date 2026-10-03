import path from "path";
import { defineConfig } from "vitest/config";

// Lean config for server/shared unit tests: just the @shared alias,
// without the client Vite config's React/Replit plugins.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    include: ["server/**/*.test.ts", "shared/**/*.test.ts"],
    // Integration tests need a live postgres; they run via
    // `npm run test:integration`, never as part of `npm test`.
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
  },
});
