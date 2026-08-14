import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/fixtures/**"],
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
