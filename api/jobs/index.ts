import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import type { RunnerJobConfig, StartJobResponse } from "../../shared/types.js";
import { normalizeGitHubRepository, startJobSchema } from "../../shared/validation.js";
import { loadServerConfig } from "../../server/config.js";
import type { ApiRequest, ApiResponse } from "../../server/http.js";
import { safeEqualString, signJobToken } from "../../server/token.js";

const HARD_TIMEOUT_MS = 25 * 60 * 1000;
const ARTIFACT_GRACE_MS = 10 * 60 * 1000;
const JOB_CONFIG_PATH = "/tmp/testsmith-job.json";

function sendError(res: ApiResponse, status: number, message: string) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: message });
}

async function activeTestSmithSandboxes(apiKey: string) {
  const paginator = await Sandbox.list({ apiKey });
  const sandboxes = await paginator.nextItems();
  return sandboxes.filter((sandbox) => sandbox.metadata?.app === "testsmith");
}

async function waitForRunner(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(baseUrl + "/healthz", {
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return;
    } catch {
      // The snapshotted runner can still be restoring.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("sandbox runner did not become ready");
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendError(res, 405, "Метод не поддерживается");
    return;
  }

  let config;
  try {
    config = loadServerConfig();
  } catch {
    sendError(res, 503, "Сервис ещё не настроен");
    return;
  }

  let body: unknown = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch {
    sendError(res, 400, "Некорректный JSON");
    return;
  }
  const parsed = startJobSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, parsed.error.issues[0]?.message || "Некорректный запрос");
    return;
  }
  if (!safeEqualString(parsed.data.accessCode, config.accessCode)) {
    sendError(res, 403, "Неверный код доступа");
    return;
  }

  let repositoryUrl: string;
  try {
    repositoryUrl = normalizeGitHubRepository(parsed.data.repositoryUrl);
  } catch (error) {
    sendError(res, 422, error instanceof Error ? error.message : "Некорректный репозиторий");
    return;
  }

  let sandbox: Sandbox | undefined;
  try {
    if ((await activeTestSmithSandboxes(config.e2bApiKey)).length >= config.maxActiveJobs) {
      sendError(res, 409, "Все рабочие места заняты. Попробуйте немного позже.");
      return;
    }

    const jobId = randomUUID();
    const hardExpiresAt = new Date(Date.now() + HARD_TIMEOUT_MS);
    sandbox = await Sandbox.create(config.e2bTemplate, {
      apiKey: config.e2bApiKey,
      secure: true,
      network: { allowPublicTraffic: true },
      timeoutMs: HARD_TIMEOUT_MS,
      metadata: {
        app: "testsmith",
        jobId,
        mode: parsed.data.mode
      }
    });

    // A deterministic second check closes the common list-then-create race.
    const contenders = (await activeTestSmithSandboxes(config.e2bApiKey)).sort((left, right) => {
      const time = left.startedAt.getTime() - right.startedAt.getTime();
      return time || left.sandboxId.localeCompare(right.sandboxId);
    });
    const visibleSelf = contenders.some((item) => item.sandboxId === sandbox?.sandboxId);
    const admitted = contenders.slice(0, config.maxActiveJobs).some((item) => item.sandboxId === sandbox?.sandboxId);
    if (visibleSelf && !admitted) {
      await sandbox.kill();
      sandbox = undefined;
      sendError(res, 409, "Все рабочие места заняты. Попробуйте немного позже.");
      return;
    }

    const streamUrl = "https://" + sandbox.getHost(8080);
    await waitForRunner(streamUrl);

    const jobToken = signJobToken(
      {
        jobId,
        sandboxId: sandbox.sandboxId,
        exp: Math.floor(hardExpiresAt.getTime() / 1000)
      },
      config.jobTokenSecret
    );

    const runnerConfig: RunnerJobConfig = {
      jobId,
      jobToken,
      repositoryUrl,
      task: parsed.data.task.trim(),
      mode: parsed.data.mode,
      openrouterApiKey: config.openrouterApiKey,
      modelId: config.modelId,
      providerOrder: config.providerOrder,
      appOrigin: config.appOrigin,
      cleanupUrl: config.appOrigin + "/api/jobs/stop",
      hardExpiresAt: hardExpiresAt.toISOString(),
      artifactGraceMs: ARTIFACT_GRACE_MS
    };

    await sandbox.files.write(JOB_CONFIG_PATH, JSON.stringify(runnerConfig), {
      user: "user"
    });

    const response: StartJobResponse = {
      jobId,
      streamUrl,
      jobToken,
      expiresAt: hardExpiresAt.toISOString()
    };
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json(response);
  } catch (error) {
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch {
        // The hard E2B timeout is the final cleanup fallback.
      }
    }
    console.error("TestSmith start failed:", error instanceof Error ? error.message : "unknown error");
    sendError(res, 502, "Не удалось создать песочницу");
  }
}
