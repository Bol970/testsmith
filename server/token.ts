import { createHmac, timingSafeEqual } from "node:crypto";
import type { JobTokenPayload } from "../shared/types.js";

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function signJobToken(payload: JobTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + signature(body, secret).toString("base64url");
}

export function verifyJobToken(token: string, secret: string, now = Date.now()): JobTokenPayload {
  const [body, encodedSignature, extra] = token.split(".");
  if (!body || !encodedSignature || extra) throw new Error("invalid token");

  const actual = Buffer.from(encodedSignature, "base64url");
  const expected = signature(body, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid token");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JobTokenPayload;
  if (
    typeof payload.jobId !== "string" ||
    typeof payload.sandboxId !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= now
  ) {
    throw new Error("expired token");
  }
  return payload;
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim() || null;
}
