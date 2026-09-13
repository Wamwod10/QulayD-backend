import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
