import { describe, expect, it } from "vitest";
import { classifyChanges, isAllowedTestChange, isUnsafeArtifactPath } from "../shared/policy.js";

describe("change policy", () => {
  it.each([
    "src/math.test.ts",
    "tests/math.ts",
    "__snapshots__/math.snap",
    "vitest.config.ts",
    "package-lock.json",
    "tsconfig.test.json"
  ])("allows test-only path %s", (path) => expect(isAllowedTestChange(path)).toBe(true));

  it.each(["src/math.ts", ".env", ".env.local", "node_modules/a.js", "../../escape", "keys/private.pem"])(
    "rejects unsafe or production path %s",
    (path) => expect(isAllowedTestChange(path)).toBe(false)
  );

  it("records attempted production changes in tests_only", () => {
    expect(classifyChanges(["tests/a.test.ts", "src/a.ts"], "tests_only")).toEqual({
      allowed: ["tests/a.test.ts"],
      excluded: ["src/a.ts"]
    });
  });

  it("still excludes generated and secret paths in fix mode", () => {
    expect(classifyChanges(["src/a.ts", "dist/a.js", ".env"], "tests_and_fix")).toEqual({
      allowed: ["src/a.ts"],
      excluded: [".env", "dist/a.js"]
    });
    expect(isUnsafeArtifactPath("C:/escape.txt")).toBe(true);
  });
});
