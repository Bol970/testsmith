import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeJobEvents, type ActiveJob } from "../src/api.js";

describe("browser event stream", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cancels an open SSE response immediately after job_done", async () => {
    let cancelled = false;
    const frame = [
      "id: 7",
      "event: job_done",
      'data: {"id":7,"type":"job_done","status":"passed","message":"done","at":"2026-01-01T00:00:00.000Z"}',
      "",
      ""
    ].join("\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
      },
      cancel() {
        cancelled = true;
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const events: string[] = [];
    const lastId = await consumeJobEvents(job(), (event) => events.push(event.type), new AbortController().signal);

    expect(lastId).toBe(7);
    expect(events).toEqual(["job_done"]);
    expect(cancelled).toBe(true);
  });
});

function job(): ActiveJob {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    streamUrl: "https://sandbox.test",
    jobToken: "signed-job-token-that-is-long-enough-for-tests",
    expiresAt: "2099-01-01T00:00:00.000Z",
    repositoryUrl: "https://github.com/lukeed/clsx",
    task: "Add tests",
    mode: "tests_only"
  };
}
