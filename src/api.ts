import type {
  JobResult,
  RunnerEvent,
  StartJobRequest,
  StartJobResponse
} from "../shared/types.js";

export type ActiveJob = StartJobResponse & {
  repositoryUrl: string;
  task: string;
  mode: StartJobRequest["mode"];
};

async function errorFrom(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: string };
    return new Error(payload.error || "HTTP " + response.status);
  } catch {
    return new Error("HTTP " + response.status);
  }
}

export async function startJob(input: StartJobRequest): Promise<ActiveJob> {
  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await errorFrom(response);
  const job = (await response.json()) as StartJobResponse;
  return {
    ...job,
    repositoryUrl: input.repositoryUrl,
    task: input.task,
    mode: input.mode
  };
}

export async function fetchJobResult(job: ActiveJob): Promise<JobResult> {
  const response = await fetch(job.streamUrl + "/result", {
    headers: sandboxHeaders(job),
    cache: "no-store"
  });
  if (!response.ok) throw await errorFrom(response);
  return response.json() as Promise<JobResult>;
}

export async function downloadArtifact(job: ActiveJob): Promise<void> {
  const response = await fetch(job.streamUrl + "/artifact", {
    headers: sandboxHeaders(job)
  });
  if (!response.ok) throw await errorFrom(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "testsmith-" + job.jobId.slice(0, 8) + ".zip";
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function stopJob(job: ActiveJob): Promise<void> {
  const response = await fetch("/api/jobs/stop", {
    method: "POST",
    headers: { Authorization: "Bearer " + job.jobToken }
  });
  if (!response.ok) throw await errorFrom(response);
}

function parseSseChunk(chunk: string): { id?: number; data?: string } {
  let id: number | undefined;
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { id, data: data.length > 0 ? data.join("\n") : undefined };
}

export async function consumeJobEvents(
  job: ActiveJob,
  onEvent: (event: RunnerEvent) => void,
  signal: AbortSignal,
  lastEventId = 0
): Promise<number> {
  const response = await fetch(job.streamUrl + "/events", {
    headers: {
      Accept: "text/event-stream",
      Authorization: "Bearer " + job.jobToken,
      "X-Access-Token": job.sandboxAccessToken,
      ...(lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {})
    },
    signal,
    cache: "no-store"
  });
  if (!response.ok || !response.body) throw await errorFrom(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let newestId = lastEventId;

  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const parsed = parseSseChunk(chunk);
      if (!parsed.data) continue;
      try {
        const event = JSON.parse(parsed.data) as RunnerEvent;
        newestId = Math.max(newestId, parsed.id ?? event.id ?? 0);
        onEvent(event);
      } catch {
        // Ignore malformed frames and keep the stream alive.
      }
    }
  }
  return newestId;
}

function sandboxHeaders(job: ActiveJob): Record<string, string> {
  return {
    Authorization: "Bearer " + job.jobToken,
    "X-Access-Token": job.sandboxAccessToken
  };
}
