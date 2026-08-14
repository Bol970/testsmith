import { describe, expect, it } from "vitest";
import { sanitizeText } from "../sandbox/src/events.js";

describe("event output cleaning", () => {
  it("removes control bytes, redacts model keys and truncates", () => {
    const fakeKey = ["sk-or-v1-", "abcdefghijklmnopqrst"].join("");
    const value = sanitizeText("ok\u0000 " + fakeKey + " tail", 24);
    expect(value).not.toContain("sk-or-v1");
    expect(value).not.toContain("\u0000");
    expect(value.length).toBeLessThanOrEqual(24);
  });
});
