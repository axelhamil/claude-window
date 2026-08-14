import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/service/**"],
      thresholds: { statements: 90, branches: 90, functions: 85, lines: 90 },
    },
  },
});
