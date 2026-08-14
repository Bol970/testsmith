import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  JobResult,
  JobStatus,
  RunnerJobConfig,
  TestRun
} from "../../shared/types.js";
import { combinedOutput, runCommand, safeCommandEnvironment, type CommandResult } from "./commands.js";
import { ARTIFACT_PATH, buildReport, createArtifacts } from "./artifacts.js";
import { runPiAgent } from "./agent.js";
import { EventStream, sanitizeText } from "./events.js";
import {
  assertWorkspaceSize,
  cloneRepository,
  createPatch,
  enforcePolicy,
  hasLockFile,
  hasTestScript,
  packageManager,
  prepareDirectories,
  restoreCheckoutChanges,
  repositoryCommitSha,
  REPOSITORY_ROOT
} from "./workspace.js";
import type { PackageManager } from "../../shared/package-manager.js";

const PORT = 8080;
const BOOTSTRAP_PATH = "/tmp/testsmith-job.json";
const events = new EventStream();
let processState: "ready" | "running" | "complete" | "error" = "ready";
let config: RunnerJobConfig | null = null;
let result: JobResult | null = null;

const server = createServer((request, response) => {
  void route(request, response).catch(() => {
    if (!response.headersSent) json(response, 500, { error: "runner_error" });
    else response.end();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("TestSmith runner ready on port " + String(PORT));
  void bootstrap();
});

setInterval(() => events.keepAlive(), 15_000).unref();

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://runner.local");
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, { ok: true, state: processState });
    return;
  }

  if (!config) {
    json(response, 425, { error: "job_not_configured" });
    return;
  }
  applyCors(response, config.appOrigin);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (!authorized(request, config.jobToken)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    const lastEventId = Number(request.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.flushHeaders();
    events.attach(response, Number.isFinite(lastEventId) ? lastEventId : 0);
    return;
  }
  if (request.method === "GET" && url.pathname === "/result") {
    if (!result) {
      json(response, 409, { error: "job_not_complete" });
      return;
    }
    json(response, 200, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/artifact") {
    if (!result || !(await fileExists(ARTIFACT_PATH))) {
      json(response, 409, { error: "artifact_not_ready" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=\"testsmith-" + config.jobId + ".zip\"",
      "Cache-Control": "private, no-store"
    });
    createReadStream(ARTIFACT_PATH).pipe(response);
    return;
  }
  json(response, 404, { error: "not_found" });
}

async function bootstrap(): Promise<void> {
  try {
    const loaded = await waitForBootstrap();
    validateConfig(loaded);
    config = loaded;
    processState = "running";
    events.status("sandbox", "Sandbox настроена, runner начал работу");
    await executeJob(loaded);
  } catch (error) {
    processState = "error";
    events.error(publicError(error));
  }
}

async function waitForBootstrap(): Promise<RunnerJobConfig> {
  while (true) {
    try {
      let raw = await readFile(BOOTSTRAP_PATH, "utf8");
      await rm(BOOTSTRAP_PATH, { force: true });
      const parsed = JSON.parse(raw) as RunnerJobConfig;
      raw = "";
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        await rm(BOOTSTRAP_PATH, { force: true });
        throw new Error("Некорректная bootstrap-конфигурация.");
      }
      await delay(250);
    }
  }
}

async function executeJob(job: RunnerJobConfig): Promise<void> {
  const startedAt = new Date().toISOString();
  let manager: PackageManager = "unknown";
  let commitSha: string | null = null;
  let baselineResult: CommandResult | null = null;
  let finalResult: CommandResult | null = null;
  let baselineLog = "Baseline не запускался.\n";
  let finalLog = "Финальный тест не запускался.\n";
  let summary = "Агент не завершил работу.";
  let timedOut = false;
  let installComplete = false;
  let cloned = false;
  let fatalError: string | null = null;
  let changedFiles: string[] = [];
  let excludedFiles: string[] = [];
  let patch = "";

  try {
    await prepareDirectories();
    events.status("clone", "Клонирование default branch");
    await cloneRepository(job.repositoryUrl);
    cloned = true;
    commitSha = await repositoryCommitSha();
    await assertWorkspaceSize("checkout");
    manager = await packageManager();

    if (manager === "bun") {
      summary = "Bun-only репозитории пока не поддерживаются. Checkout сохранён без изменений.";
    } else if (manager === "unknown") {
      fatalError = "Не найден поддерживаемый JavaScript/TypeScript package manager.";
    } else {
      events.status("install", "Установка зависимостей через " + manager);
      const installResult = await installDependencies(manager);
      installComplete = installResult.exitCode === 0 && !installResult.timedOut;
      await restoreCheckoutChanges();
      await assertWorkspaceSize("installed");

      events.status("baseline", "Независимый baseline test");
      baselineResult = await runOfficialTest(manager);
      baselineLog = baselineResult ? combinedOutput(baselineResult) + "\n" : "В package.json нет test script.\n";

      events.status("agent", "Pi agent анализирует проект и создаёт тесты");
      let runtimeKey = job.openrouterApiKey;
      job.openrouterApiKey = "";
      try {
        const agent = await runPiAgent({
          task: job.task,
          mode: job.mode,
          modelId: job.modelId,
          providerOrder: job.providerOrder,
          openrouterApiKey: runtimeKey,
          events,
          runOfficialTest: () => runOfficialTest(manager)
        });
        timedOut = agent.timedOut;
        summary = agent.summary ?? (timedOut ? "Рабочий лимит агента истёк; возвращены частичные изменения." : "Pi agent завершил работу без структурированного резюме.");
      } catch (error) {
        summary = "Pi agent завершился с ошибкой: " + publicError(error);
      } finally {
        runtimeKey = "";
      }

      const policy = await enforcePolicy(job.mode);
      changedFiles = policy.allowed;
      excludedFiles = policy.excluded;
      patch = await createPatch(changedFiles);

      events.status("final_test", "Независимый финальный test run");
      manager = await packageManager();
      finalResult = await runOfficialTest(manager);
      finalLog = finalResult ? combinedOutput(finalResult) + "\n" : "В package.json нет test script.\n";
    }
  } catch (error) {
    fatalError = publicError(error);
    summary = fatalError;
    events.error(fatalError);
    if (cloned) {
      try {
        const policy = await enforcePolicy(job.mode);
        changedFiles = policy.allowed;
        excludedFiles = policy.excluded;
        patch = await createPatch(changedFiles);
      } catch {
        // A partial report is still useful when git metadata itself is damaged.
      }
    }
  }

  const status = deriveStatus({
    manager,
    timedOut,
    fatalError,
    changedFiles,
    excludedFiles,
    finalResult,
    installComplete
  });
  const finishedAt = new Date().toISOString();
  const artifactExpiresAt = new Date(Date.now() + job.artifactGraceMs).toISOString();
  const resultWithoutReport: Omit<JobResult, "reportMarkdown"> = {
    jobId: job.jobId,
    repositoryUrl: job.repositoryUrl,
    commitSha,
    task: job.task,
    mode: job.mode,
    status,
    packageManager: manager,
    summary: sanitizeText(summary, 4_000),
    baseline: commandToTestRun(baselineResult),
    finalTest: commandToTestRun(finalResult),
    changedFiles,
    excludedFiles,
    patch,
    baselineLog,
    finalTestLog: finalLog,
    startedAt,
    finishedAt,
    artifactExpiresAt
  };
  result = { ...resultWithoutReport, reportMarkdown: buildReport(resultWithoutReport) };

  events.status("artifacts", "Формирование воспроизводимого ZIP-архива");
  await createArtifacts(result, changedFiles);
  processState = "complete";
  events.status("done", "Задание завершено: " + status);
  events.done(status, summary);
  scheduleCleanup(job.cleanupUrl, job.jobToken, job.artifactGraceMs);
}

async function installDependencies(manager: PackageManager): Promise<CommandResult> {
  const locked = await hasLockFile(manager);
  if (manager === "npm") {
    return runCommand("npm", locked ? ["ci"] : ["install", "--no-package-lock"], commandOptions(240_000));
  }
  if (manager === "pnpm") {
    return runCommand("pnpm", locked ? ["install", "--frozen-lockfile"] : ["install"], commandOptions(240_000));
  }
  if (manager === "yarn") {
    return runCommand("yarn", locked ? ["install", "--immutable"] : ["install"], commandOptions(240_000));
  }
  throw new Error("Неподдерживаемый package manager: " + manager);
}

async function runOfficialTest(manager: PackageManager): Promise<CommandResult | null> {
  if (!(await hasTestScript())) return null;
  if (manager === "npm") return runCommand("npm", ["test"], commandOptions(180_000));
  if (manager === "pnpm") return runCommand("pnpm", ["test"], commandOptions(180_000));
  if (manager === "yarn") return runCommand("yarn", ["test"], commandOptions(180_000));
  return null;
}

function commandOptions(timeoutMs: number) {
  return {
    cwd: REPOSITORY_ROOT,
    timeoutMs,
    env: safeCommandEnvironment(),
    maxOutputBytes: 2_000_000
  };
}

function commandToTestRun(command: CommandResult | null): TestRun {
  if (!command) return { command: null, exitCode: null, durationMs: 0, state: "missing" };
  return {
    command: command.command,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    state: command.timedOut ? "timeout" : command.exitCode === 0 ? "passed" : "failed"
  };
}

function deriveStatus(input: {
  manager: PackageManager;
  timedOut: boolean;
  fatalError: string | null;
  changedFiles: string[];
  excludedFiles: string[];
  finalResult: CommandResult | null;
  installComplete: boolean;
}): JobStatus {
  if (input.timedOut) return "timeout";
  if (input.excludedFiles.length > 0) return "policy_violation";
  if (input.manager === "bun") return "degraded";
  if (input.fatalError && input.changedFiles.length === 0) return "failed";
  if (input.finalResult?.exitCode === 0 && !input.finalResult.timedOut && input.installComplete) return "passed";
  if (input.changedFiles.length > 0) return "degraded";
  return "failed";
}

function validateConfig(value: RunnerJobConfig): void {
  if (!value || typeof value !== "object") throw new Error("Bootstrap config отсутствует.");
  if (!/^[0-9a-f-]{36}$/i.test(value.jobId)) throw new Error("Некорректный jobId.");
  if (!value.jobToken || value.jobToken.length < 40) throw new Error("Некорректный job token.");
  const repository = new URL(value.repositoryUrl);
  if (repository.protocol !== "https:" || repository.hostname !== "github.com") throw new Error("Разрешены только github.com репозитории.");
  if (value.task.length < 3 || value.task.length > 2_000) throw new Error("Некорректная длина задачи.");
  if (!Array.isArray(value.providerOrder) || value.providerOrder.length !== 2) throw new Error("Нужны ровно два OpenRouter endpoint.");
  const origin = new URL(value.appOrigin);
  const cleanup = new URL(value.cleanupUrl);
  if (origin.origin !== value.appOrigin || cleanup.origin !== origin.origin || cleanup.pathname !== "/api/jobs/stop") {
    throw new Error("Некорректный APP_ORIGIN или cleanup URL.");
  }
  if (new Date(value.hardExpiresAt).getTime() <= Date.now()) throw new Error("Job token уже истёк.");
  if (value.artifactGraceMs !== 600_000) throw new Error("Некорректный срок хранения артефактов.");
  if (!value.openrouterApiKey) throw new Error("OpenRouter key отсутствует.");
}

function applyCors(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, E2B-Traffic-Access-Token, Last-Event-ID, Content-Type"
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function publicError(error: unknown): string {
  if (error instanceof Error) return sanitizeText(error.message, 2_000);
  return "Неизвестная ошибка runner'а.";
}

function scheduleCleanup(url: string, token: string, afterMs: number): void {
  setTimeout(() => {
    void cleanup(url, token);
  }, afterMs).unref();
}

async function cleanup(url: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + token }
      });
      if (response.ok) return;
    } catch {
      // The E2B hard timeout remains the final cleanup backstop.
    }
    await delay(5_000 * (attempt + 1));
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
