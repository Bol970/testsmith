import { spawn } from "node:child_process";

export type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

type RunOptions = {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void;
};

function appendLimited(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next) <= maxBytes) return next;
  const suffix = Buffer.from(next).subarray(-maxBytes).toString("utf8");
  return "[...output truncated...]\n" + suffix;
}

export function safeCommandEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/user",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    ...extra
  };
}

export async function runCommand(
  executable: string,
  args: string[],
  options: RunOptions
): Promise<CommandResult> {
  const startedAt = Date.now();
  const command = [executable, ...args].join(" ");
  const maxBytes = options.maxOutputBytes ?? 1_000_000;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? safeCommandEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString("utf8");
      stdout = appendLimited(stdout, chunk, maxBytes);
      options.onOutput?.(chunk, "stdout");
    });
    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString("utf8");
      stderr = appendLimited(stderr, chunk, maxBytes);
      options.onOutput?.(chunk, "stderr");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut
      });
    });
  });
}

export function runShell(command: string, options: RunOptions): Promise<CommandResult> {
  return runCommand("/bin/bash", ["-lc", command], options);
}

export function combinedOutput(result: CommandResult): string {
  const blocks = [
    "$ " + result.command,
    result.stdout.trim(),
    result.stderr.trim(),
    "exit=" + String(result.exitCode) + (result.timedOut ? " timeout=true" : "")
  ].filter(Boolean);
  return blocks.join("\n");
}
