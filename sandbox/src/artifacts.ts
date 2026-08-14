import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import archiver from "archiver";
import type { JobResult } from "../../shared/types.js";
import { copyChangedFiles, OUTPUT_ROOT } from "./workspace.js";

export const ARTIFACT_PATH = "/home/user/testsmith-result.zip";

export async function createArtifacts(result: JobResult, allowedFiles: string[]): Promise<void> {
  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(join(OUTPUT_ROOT, "changed-files"), { recursive: true });
  const copied = await copyChangedFiles(allowedFiles, join(OUTPUT_ROOT, "changed-files"));

  await Promise.all([
    writeFile(join(OUTPUT_ROOT, "report.md"), result.reportMarkdown, "utf8"),
    writeFile(join(OUTPUT_ROOT, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8"),
    writeFile(join(OUTPUT_ROOT, "changes.patch"), result.patch, "utf8"),
    writeFile(join(OUTPUT_ROOT, "baseline.log"), result.baselineLog, "utf8"),
    writeFile(join(OUTPUT_ROOT, "final-tests.log"), result.finalTestLog, "utf8")
  ]);

  const files = await collectFiles(OUTPUT_ROOT);
  const manifestEntries = await Promise.all(
    files.map(async (path) => ({
      path: relative(OUTPUT_ROOT, path).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      bytes: (await lstat(path)).size
    }))
  );
  await writeFile(
    join(OUTPUT_ROOT, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        jobId: result.jobId,
        generatedAt: result.finishedAt,
        artifactExpiresAt: result.artifactExpiresAt,
        copiedChangedFiles: copied,
        files: manifestEntries.sort((a, b) => a.path.localeCompare(b.path))
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await rm(ARTIFACT_PATH, { force: true });
  await zipDirectory(OUTPUT_ROOT, ARTIFACT_PATH);
}

export function buildReport(result: Omit<JobResult, "reportMarkdown">): string {
  const changed = result.changedFiles.length
    ? result.changedFiles.map((path) => "- `" + escapeInline(path) + "`").join("\n")
    : "Изменённых файлов нет.";
  const excluded = result.excludedFiles.length
    ? result.excludedFiles.map((path) => "- `" + escapeInline(path) + "`").join("\n")
    : "Нет.";
  return [
    "# Отчёт TestSmith",
    "",
    "**Статус:** `" + result.status + "`  ",
    "**Репозиторий:** " + result.repositoryUrl + "  ",
    "**Commit:** `" + (result.commitSha ?? "не определён") + "`  ",
    "**Режим:** `" + result.mode + "`  ",
    "**Package manager:** `" + result.packageManager + "`",
    "",
    "## Результат",
    "",
    result.summary,
    "",
    "## Проверки",
    "",
    "- Baseline: `" + result.baseline.state + "`, exit `" + String(result.baseline.exitCode) + "`, " + String(result.baseline.durationMs) + " ms",
    "- Final: `" + result.finalTest.state + "`, exit `" + String(result.finalTest.exitCode) + "`, " + String(result.finalTest.durationMs) + " ms",
    "",
    "## Изменённые файлы",
    "",
    changed,
    "",
    "## Исключённые политикой файлы",
    "",
    excluded,
    "",
    "## Задача",
    "",
    result.task,
    "",
    "---",
    "Отчёт сформирован runner'ом независимо от текстовых утверждений агента."
  ].join("\n");
}

async function collectFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result;
}

async function zipDirectory(source: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination, { mode: 0o600 });
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(source, false);
    void archive.finalize();
  });
}

function escapeInline(value: string): string {
  return value.replaceAll("`", "\\`");
}
