import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "overlay/src/**/*.test.ts"],
    // The v3 score-pack suites are CPU-heavy; under parallel load light tests
    // can exceed the 5 s default without being slow themselves.
    testTimeout: 20_000,
  },
});
