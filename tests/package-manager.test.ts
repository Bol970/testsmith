import { describe, expect, it } from "vitest";
import { detectPackageManager, installCommand, testCommand } from "../shared/package-manager.js";

describe("package manager detection", () => {
  it.each([
    [["package.json", "package-lock.json"], "npm"],
    [["package.json", "pnpm-lock.yaml", "package-lock.json"], "pnpm"],
    [["package.json", "yarn.lock"], "yarn"],
    [["package.json", "bun.lock"], "bun"],
    [[], "unknown"]
  ] as const)("detects %j as %s", (files, expected) => {
    expect(detectPackageManager(files)).toBe(expected);
  });

  it("produces deterministic install and test commands", () => {
    expect(installCommand("npm", true)).toBe("npm ci");
    expect(installCommand("pnpm", true)).toContain("--frozen-lockfile");
    expect(testCommand("yarn")).toBe("yarn test");
    expect(testCommand("bun")).toBeNull();
  });
});
