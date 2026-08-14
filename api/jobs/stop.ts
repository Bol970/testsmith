import { Sandbox } from "e2b";
import { loadServerConfig } from "../../server/config.js";
import type { ApiRequest, ApiResponse } from "../../server/http.js";
import { bearerToken, verifyJobToken } from "../../server/token.js";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let config;
  try {
    config = loadServerConfig();
  } catch {
    res.status(503).json({ error: "service is not configured" });
    return;
  }

  const token = bearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }

  let payload;
  try {
    payload = verifyJobToken(token, config.jobTokenSecret);
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }

  try {
    const sandbox = await Sandbox.connect(payload.sandboxId, {
      apiKey: config.e2bApiKey
    });
    const info = await sandbox.getInfo();
    if (info.metadata?.app !== "testsmith" || info.metadata?.jobId !== payload.jobId) {
      res.status(403).json({ error: "sandbox metadata mismatch" });
      return;
    }
    await sandbox.kill();
    res.status(200).json({ ok: true });
  } catch (error) {
    console.warn("TestSmith cleanup:", error instanceof Error ? error.message : "already stopped");
    res.status(200).json({ ok: true, alreadyStopped: true });
  }
}
