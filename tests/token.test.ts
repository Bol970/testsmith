import { describe, expect, it } from "vitest";
import { bearerToken, safeEqualString, signJobToken, verifyJobToken } from "../server/token.js";

const secret = "a-long-test-secret-that-is-not-a-real-credential";

describe("job tokens", () => {
  it("signs and verifies a valid token", () => {
    const payload = { jobId: "job", sandboxId: "sandbox", exp: 2_000_000_000 };
    expect(verifyJobToken(signJobToken(payload, secret), secret, 1_000)).toEqual(payload);
  });

  it("rejects tampering and expiration", () => {
    const token = signJobToken({ jobId: "job", sandboxId: "sandbox", exp: 10 }, secret);
    expect(() => verifyJobToken(token + "x", secret, 1_000)).toThrow();
    expect(() => verifyJobToken(token, secret, 11_000)).toThrow();
  });

  it("uses strict bearer parsing and safe equality", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(safeEqualString("same", "same")).toBe(true);
    expect(safeEqualString("short", "longer")).toBe(false);
  });
});
