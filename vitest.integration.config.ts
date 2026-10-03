import path from "path";
import { defineConfig } from "vitest/config";

// Integration config: runs only *.integration.test.ts against a live
// postgres (CI provisions a scratch service; see .github/workflows/ci.yml).
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    include: ["server/**/*.integration.test.ts"],
  },
});
