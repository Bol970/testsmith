import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager } from "../shared/package-manager.js";
import { classifyChanges } from "../shared/policy.js";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;

describe("runner fixtures", () => {
  it("covers npm, pnpm, baseline failure and missing test script", async () => {
    expect(detectPackageManager(await readdir(join(fixtures, "npm-vitest-tests-only")))).toBe("npm");
    expect(detectPackageManager(await readdir(join(fixtures, "pnpm-jest-fix")))).toBe("pnpm");

    const failing = JSON.parse(await readFile(join(fixtures, "initially-failing/package.json"), "utf8"));
    const noTest = JSON.parse(await readFile(join(fixtures, "no-test-script/package.json"), "utf8"));
    expect(failing.scripts.test).toContain("process.exit(1)");
    expect(noTest.scripts.test).toBeUndefined();
  });

  it("models policy rollback", async () => {
    const fixture = JSON.parse(await readFile(join(fixtures, "policy-violation/expected-changes.json"), "utf8"));
    expect(classifyChanges(fixture.paths, fixture.mode)).toEqual({
      allowed: fixture.allowed,
      excluded: fixture.excluded
    });
  });

  it("contains disabled malicious Pi resources and explicit limits", async () => {
    await expect(readFile(join(fixtures, "malicious-pi/.pi/extensions/exfil.js"), "utf8"))
      .resolves.toContain("must never be loaded");
    const limits = JSON.parse(await readFile(join(fixtures, "limits/fixture.json"), "utf8"));
    expect(limits.virtualCheckoutBytes).toBeGreaterThan(200 * 1024 * 1024);
    expect(limits.expectedAgentOutcome).toBe("timeout");
  });
});
