import { beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => {
  const write = vi.fn();
  const kill = vi.fn();
  const getInfo = vi.fn(async () => ({ metadata: { app: "testsmith", jobId: "cleanup-job" } }));
  const create = vi.fn(async () => ({
    sandboxId: "sandbox-1",
    trafficAccessToken: "traffic-token",
    getHost: () => "8080-sandbox.e2b.app",
    files: { write },
    kill
  }));
  const nextItems = vi.fn(async () => []);
  const connect = vi.fn(async () => ({ getInfo, kill }));
  return { write, kill, create, nextItems, getInfo, connect };
});

vi.mock("e2b", () => ({
  Sandbox: {
    create: e2b.create,
    list: vi.fn(async () => ({ nextItems: e2b.nextItems })),
    connect: e2b.connect
  }
}));

import handler from "../api/jobs/index.js";
import stopHandler from "../api/jobs/stop.js";
import { signJobToken } from "../server/token.js";

describe("POST /api/jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    e2b.nextItems.mockResolvedValue([]);
    e2b.write.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    Object.assign(process.env, {
      E2B_API_KEY: "e2b-test-placeholder",
      OPENROUTER_API_KEY: "openrouter-test-placeholder",
      ACCESS_CODE: "correct horse",
      JOB_TOKEN_SECRET: "job-token-test-secret-at-least-32-chars",
      APP_ORIGIN: "https://testsmith.example",
      OPENROUTER_PROVIDER_ORDER: "provider-a,provider-b",
      MAX_ACTIVE_JOBS: "2"
    });
  });

  it("creates a secure sandbox and writes bootstrap via Files API", async () => {
    const response = fakeResponse();
    await handler(request({ accessCode: "correct horse" }), response as any);
    expect(response.statusCode).toBe(202);
    expect(e2b.create).toHaveBeenCalledWith("testsmith-agent-v1", expect.objectContaining({ secure: true }));
    expect(e2b.write).toHaveBeenCalledWith("/tmp/testsmith-job.json", expect.any(String), { user: "user" });
    expect(response.body).toEqual(expect.objectContaining({ sandboxAccessToken: "traffic-token" }));
  });

  it("rejects an invalid access code before E2B", async () => {
    const response = fakeResponse();
    await handler(request({ accessCode: "wrong" }), response as any);
    expect(response.statusCode).toBe(403);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("enforces the active sandbox capacity", async () => {
    e2b.nextItems.mockResolvedValue([
      { metadata: { app: "testsmith" } },
      { metadata: { app: "testsmith" } }
    ] as any);
    const response = fakeResponse();
    await handler(request({ accessCode: "correct horse" }), response as any);
    expect(response.statusCode).toBe(409);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("releases a losing sandbox in a concurrent capacity race", async () => {
    e2b.nextItems
      .mockResolvedValueOnce([
        sandboxInfo("older-1", "2026-01-01T00:00:00Z")
      ] as any)
      .mockResolvedValueOnce([
        sandboxInfo("older-1", "2026-01-01T00:00:00Z"),
        sandboxInfo("older-2", "2026-01-01T00:00:01Z"),
        sandboxInfo("sandbox-1", "2026-01-01T00:00:02Z")
      ] as any);
    const response = fakeResponse();
    await handler(request({ accessCode: "correct horse" }), response as any);
    expect(response.statusCode).toBe(409);
    expect(e2b.kill).toHaveBeenCalledOnce();
  });

  it("kills a sandbox when bootstrap fails", async () => {
    e2b.write.mockRejectedValueOnce(new Error("write failed"));
    const response = fakeResponse();
    await handler(request({ accessCode: "correct horse" }), response as any);
    expect(response.statusCode).toBe(502);
    expect(e2b.kill).toHaveBeenCalledOnce();
  });
});

describe("POST /api/jobs/stop", () => {
  it("verifies token metadata and destroys the matching sandbox", async () => {
    vi.clearAllMocks();
    const secret = "job-token-test-secret-at-least-32-chars";
    Object.assign(process.env, {
      E2B_API_KEY: "e2b-test-placeholder",
      OPENROUTER_API_KEY: "openrouter-test-placeholder",
      ACCESS_CODE: "correct horse",
      JOB_TOKEN_SECRET: secret,
      APP_ORIGIN: "https://testsmith.example",
      OPENROUTER_PROVIDER_ORDER: "provider-a,provider-b"
    });
    const token = signJobToken({
      jobId: "cleanup-job",
      sandboxId: "sandbox-1",
      exp: Math.floor(Date.now() / 1000) + 60
    }, secret);
    const response = fakeResponse();
    await stopHandler({ method: "POST", body: {}, headers: { authorization: "Bearer " + token } }, response);
    expect(response.statusCode).toBe(200);
    expect(e2b.connect).toHaveBeenCalledWith("sandbox-1", expect.any(Object));
    expect(e2b.kill).toHaveBeenCalled();
  });
});

function request(overrides: Record<string, unknown>) {
  return {
    method: "POST",
    body: {
      repositoryUrl: "https://github.com/openai/openai-node",
      task: "Add boundary tests",
      mode: "tests_only",
      ...overrides
    },
    headers: {}
  } as any;
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) { this.headers.set(name, value); },
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; }
  };
}

function sandboxInfo(sandboxId: string, startedAt: string) {
  return {
    sandboxId,
    startedAt: new Date(startedAt),
    metadata: { app: "testsmith" }
  };
}
