import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Cover ONLY our source — never the vendored engine (which lives in a
      // completely separate repo anyway). This keeps the coverage number an
      // honest measure of our own code.
      include: ["src/**", "engine-bridge/apply-bridge.core.mjs"],
      exclude: [
        // The CLI shell only: stdio transport, signal handlers (env -> config is configFromEnv).
        // Everything it wires up (context.ts, tools.ts) IS covered below, driven
        // through a real MCP client/server pair in test/tools.test.ts.
        "src/server.ts",
        "src/**/*.d.ts",
        // apply-bridge.mjs is the thin CLI shell (argv -> applyBridge); its logic
        // lives in apply-bridge.core.mjs, which IS unit-covered below.
        "engine-bridge/apply-bridge.mjs",
      ],
      reporter: ["text", "html"],
      // 100% across the board for our own code. The bar is intentionally
      // strict — see AGENTS.md. The CLI entrypoint is the only exclusion.
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
