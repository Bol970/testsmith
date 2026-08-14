export const jobModes = ["tests_only", "tests_and_fix"] as const;
export type JobMode = (typeof jobModes)[number];

export const jobStatuses = [
  "queued",
  "running",
  "passed",
  "degraded",
  "policy_violation",
  "failed",
  "timeout"
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobPhases = [
  "sandbox",
  "clone",
  "install",
  "baseline",
  "agent",
  "final_test",
  "artifacts",
  "done"
] as const;
export type JobPhase = (typeof jobPhases)[number];

export type TestRun = {
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  state: "passed" | "failed" | "missing" | "timeout" | "skipped";
};

export type JobResult = {
  jobId: string;
  repositoryUrl: string;
  commitSha: string | null;
  task: string;
  mode: JobMode;
  status: JobStatus;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  summary: string;
  baseline: TestRun;
  finalTest: TestRun;
  changedFiles: string[];
  excludedFiles: string[];
  reportMarkdown: string;
  patch: string;
  baselineLog: string;
  finalTestLog: string;
  startedAt: string;
  finishedAt: string;
  artifactExpiresAt: string;
};

export type RunnerEvent =
  | {
      id: number;
      type: "job_status";
      phase: JobPhase;
      message: string;
      at: string;
    }
  | {
      id: number;
      type: "agent_text";
      text: string;
      at: string;
    }
  | {
      id: number;
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      summary: string;
      at: string;
    }
  | {
      id: number;
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      summary: string;
      durationMs: number;
      at: string;
    }
  | {
      id: number;
      type: "job_done";
      status: JobStatus;
      message: string;
      at: string;
    }
  | {
      id: number;
      type: "runner_error";
      message: string;
      at: string;
    };

export type StartJobRequest = {
  repositoryUrl: string;
  task: string;
  mode: JobMode;
  accessCode: string;
};

export type StartJobResponse = {
  jobId: string;
  streamUrl: string;
  jobToken: string;
  /** Short-lived E2B proxy credential; sent only as X-Access-Token, never in a URL. */
  sandboxAccessToken: string;
  expiresAt: string;
};

export type JobTokenPayload = {
  jobId: string;
  sandboxId: string;
  exp: number;
};

export type RunnerJobConfig = {
  jobId: string;
  jobToken: string;
  repositoryUrl: string;
  task: string;
  mode: JobMode;
  openrouterApiKey: string;
  modelId: string;
  providerOrder: string[];
  appOrigin: string;
  cleanupUrl: string;
  hardExpiresAt: string;
  artifactGraceMs: number;
};
