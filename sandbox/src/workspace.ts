import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  detectPackageManager,
  type PackageManager
} from "../../shared/package-manager.js";
import { classifyChanges, isUnsafeArtifactPath } from "../../shared/policy.js";
import type { JobMode } from "../../shared/types.js";
import { combinedOutput, runCommand, safeCommandEnvironment, type CommandResult } from "./commands.js";

export const WORKSPACE_ROOT = "/home/user/workspace";
export const REPOSITORY_ROOT = join(WORKSPACE_ROOT, "repository");
export const OUTPUT_ROOT = "/home/user/output";

const INITIAL_LIMIT_BYTES = 200 * 1024 * 1024;
const INSTALLED_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;

export async function prepareDirectories(): Promise<void> {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await rm(REPOSITORY_ROOT, { recursive: true, force: true });
}

export async function cloneRepository(repositoryUrl: string): Promise<CommandResult> {
  const result = await runCommand(
    "git",
    ["-c", "credential.helper=", "clone", "--depth=1", "--single-branch", "--no-tags", repositoryUrl, REPOSITORY_ROOT],
    { cwd: WORKSPACE_ROOT, timeoutMs: 90_000, env: safeCommandEnvironment() }
  );
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("Не удалось клонировать репозиторий.\n" + combinedOutput(result));
  }
  await runCommand("git", ["remote", "remove", "origin"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 10_000,
    env: safeCommandEnvironment()
  });
  return result;
}

export async function repositoryCommitSha(): Promise<string | null> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 10_000,
    env: safeCommandEnvironment()
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function assertWorkspaceSize(stage: "checkout" | "installed"): Promise<number> {
  const bytes = await directorySize(REPOSITORY_ROOT);
  const limit = stage === "checkout" ? INITIAL_LIMIT_BYTES : INSTALLED_LIMIT_BYTES;
  if (bytes > limit) {
    throw new Error(
      stage === "checkout"
        ? "Исходный checkout превышает лимит 200 МБ."
        : "Рабочая директория после установки превышает лимит 4 ГБ."
    );
  }
  return bytes;
}

export async function packageManager(): Promise<PackageManager> {
  const files = await readdir(REPOSITORY_ROOT);
  return detectPackageManager(files);
}

export async function hasLockFile(manager: PackageManager): Promise<boolean> {
  const names = new Set(await readdir(REPOSITORY_ROOT));
  if (manager === "npm") return names.has("package-lock.json") || names.has("npm-shrinkwrap.json");
  if (manager === "pnpm") return names.has("pnpm-lock.yaml");
  if (manager === "yarn") return names.has("yarn.lock");
  return false;
}

export async function hasTestScript(): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return typeof manifest.scripts?.test === "string" && manifest.scripts.test.trim().length > 0;
  } catch {
    return false;
  }
}

export async function readUntrustedAgentsFile(): Promise<string | null> {
  try {
    const raw = await readFile(join(REPOSITORY_ROOT, "AGENTS.md"), "utf8");
    return raw.slice(0, 16_384);
  } catch {
    return null;
  }
}

export async function listChangedFiles(): Promise<string[]> {
  const tracked = await runCommand("git", ["diff", "HEAD", "--name-only", "--no-renames", "-z", "--"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 15_000,
    env: safeCommandEnvironment(),
    maxOutputBytes: 5_000_000
  });
  const untracked = await runCommand(
    "git",
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--exclude=node_modules/",
      "--exclude=.git/",
      "--exclude=dist/",
      "--exclude=build/",
      "--exclude=coverage/",
      "--exclude=.next/",
      "--exclude=.turbo/",
      "--exclude=.cache/",
      "-z",
      "--"
    ],
    {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 15_000,
    env: safeCommandEnvironment(),
    maxOutputBytes: 5_000_000
    }
  );
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0) {
    throw new Error("Не удалось получить список изменений git.");
  }
  return [...new Set((tracked.stdout + untracked.stdout).split("\0").filter(Boolean))].sort();
}

/** Discards side effects produced by dependency install scripts before the agent starts. */
export async function restoreCheckoutChanges(): Promise<string[]> {
  const paths = await listChangedFiles();
  for (const path of paths) await restorePathToHead(path);
  return paths;
}

export async function enforcePolicy(mode: JobMode): Promise<{
  allowed: string[];
  excluded: string[];
}> {
  const classification = classifyChanges(await listChangedFiles(), mode);
  if (classification.excluded.length === 0) return classification;

  for (const path of classification.excluded) {
    if (!isRepositoryRelativePath(path)) continue;
    await restorePathToHead(path);
  }

  return classification;
}

function isRepositoryRelativePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[a-z]:\//i.test(normalized) && !normalized.split("/").includes("..");
}

async function restorePathToHead(path: string): Promise<void> {
  const trackedAtHead = await runCommand("git", ["cat-file", "-e", "HEAD:" + path], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 10_000,
    env: safeCommandEnvironment()
  });
  await runCommand("git", ["restore", "--staged", "--", path], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 10_000,
    env: safeCommandEnvironment()
  });
  if (trackedAtHead.exitCode === 0) {
    const restored = await runCommand("git", ["restore", "--source=HEAD", "--worktree", "--", path], {
      cwd: REPOSITORY_ROOT,
      timeoutMs: 15_000,
      env: safeCommandEnvironment()
    });
    if (restored.exitCode !== 0) throw new Error("Не удалось восстановить " + path);
  } else {
    await rm(safeRepositoryPath(path), { recursive: true, force: true });
  }
}

export async function createPatch(allowedFiles: string[]): Promise<string> {
  const safe = allowedFiles.filter((path) => !isUnsafeArtifactPath(path));
  if (safe.length === 0) return "";
  await runCommand("git", ["add", "--intent-to-add", "--", ...safe], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 30_000,
    env: safeCommandEnvironment()
  });
  const result = await runCommand("git", ["diff", "--no-ext-diff", "--binary", "--", ...safe], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 30_000,
    env: safeCommandEnvironment(),
    maxOutputBytes: 15_000_000
  });
  return result.stdout;
}

export async function copyChangedFiles(paths: string[], destination: string): Promise<string[]> {
  const copied: string[] = [];
  for (const path of paths) {
    if (isUnsafeArtifactPath(path)) continue;
    const source = safeRepositoryPath(path);
    try {
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
      const canonicalRoot = await realpath(REPOSITORY_ROOT);
      const canonicalSource = await realpath(source);
      if (canonicalSource !== canonicalRoot && !canonicalSource.startsWith(canonicalRoot + sep)) continue;
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: stat.isDirectory(), dereference: false });
      copied.push(path);
    } catch {
      // Deleted files are represented by the patch and do not have a payload to copy.
    }
  }
  return copied;
}

function safeRepositoryPath(path: string): string {
  const absolute = resolve(REPOSITORY_ROOT, path);
  const rel = relative(REPOSITORY_ROOT, absolute);
  if (rel.startsWith("..") || rel === "" || rel.startsWith(sep)) {
    throw new Error("Unsafe repository path: " + path);
  }
  return absolute;
}

async function directorySize(root: string): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) bytes += (await lstat(path)).size;
      if (bytes > INSTALLED_LIMIT_BYTES) return bytes;
    }
  }
  return bytes;
}
