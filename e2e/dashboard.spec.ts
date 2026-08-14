import { expect, test, type Page } from "@playwright/test";

const job = {
  jobId: "11111111-1111-4111-8111-111111111111",
  streamUrl: "https://sandbox.test",
  jobToken: "signed-job-token-that-is-long-enough-for-tests",
  sandboxAccessToken: "sandbox-traffic-token",
  expiresAt: "2099-01-01T00:00:00.000Z"
};

test("shows access-code errors without starting a workspace", async ({ page }) => {
  await page.route("**/api/jobs", async (route) => {
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Неверный код доступа" }) });
  });
  await page.goto("/");
  await page.getByLabel("Код доступа").fill("wrong");
  await page.getByRole("button", { name: "Запустить TestSmith" }).click();
  await expect(page.getByText("Неверный код доступа")).toBeVisible();
});

for (const mode of ["Только тесты", "Тесты + исправление"]) {
  test("completes mocked runner flow in mode: " + mode, async ({ page }) => {
    await mockCompletedJob(page);
    await page.goto("/");
    await page.getByLabel(mode).check();
    await page.getByLabel("Код доступа").fill("access");
    await page.getByRole("button", { name: "Запустить TestSmith" }).click();

    await expect(page.getByText("Проверка пройдена")).toBeVisible();
    await expect(page.locator("article.markdown script")).toHaveCount(0);
    await page.getByRole("button", { name: "Changes.patch" }).click();
    await expect(page.getByText("+export const covered = true;", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Логи тестов" }).click();
    await expect(page.getByText("tests passed", { exact: true }).first()).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Скачать ZIP/ }).click();
    expect((await download).suggestedFilename()).toContain("testsmith-");
  });
}

test("restores an active job from sessionStorage after reload", async ({ page }) => {
  await mockCompletedJob(page);
  await page.goto("/");
  await page.evaluate((saved) => {
    sessionStorage.setItem("testsmith-active-job-v1", JSON.stringify({
      ...saved,
      repositoryUrl: "https://github.com/openai/openai-node",
      task: "Reload test",
      mode: "tests_only"
    }));
  }, job);
  await page.reload();
  await expect(page.getByText("Проверка пройдена")).toBeVisible();
  await expect(page.getByRole("heading", { name: "openai/openai-node" })).toBeVisible();
});

async function mockCompletedJob(page: Page) {
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(job) });
  });
  await page.route("https://sandbox.test/events", async (route) => {
    const headers = corsHeaders();
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const frames = [
      event(1, "job_status", { phase: "agent", message: "Pi работает" }),
      event(2, "agent_text", { text: "Проверяю публичный API" }),
      event(3, "job_status", { phase: "done", message: "Готово" }),
      event(4, "job_done", { status: "passed", message: "Тесты добавлены" })
    ].join("");
    await route.fulfill({ status: 200, headers: { ...headers, "Content-Type": "text/event-stream" }, body: frames });
  });
  await page.route("https://sandbox.test/result", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(jobResult())
    });
  });
  await page.route("https://sandbox.test/artifact", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    await route.fulfill({
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=testsmith-result.zip"
      },
      body: "mock zip"
    });
  });
}

function event(id: number, type: string, body: Record<string, unknown>) {
  return "id: " + id + "\nevent: " + type + "\ndata: " + JSON.stringify({ id, type, at: new Date().toISOString(), ...body }) + "\n\n";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "http://127.0.0.1:4173",
    "Access-Control-Allow-Headers": "Authorization, X-Access-Token, Last-Event-ID, Content-Type"
  };
}

function jobResult() {
  return {
    jobId: job.jobId,
    repositoryUrl: "https://github.com/openai/openai-node.git",
    commitSha: "0123456789abcdef",
    task: "Add boundary tests",
    mode: "tests_only",
    status: "passed",
    packageManager: "npm",
    summary: "Тесты добавлены",
    baseline: { command: "npm test", exitCode: 0, durationMs: 100, state: "passed" },
    finalTest: { command: "npm test", exitCode: 0, durationMs: 120, state: "passed" },
    changedFiles: ["tests/new.test.ts"],
    excludedFiles: [],
    reportMarkdown: "# Безопасный отчёт\n\n<script>window.pwned=true</script>\n\nГотово.",
    patch: "@@ -0,0 +1 @@\n+export const covered = true;\n",
    baselineLog: "tests passed",
    finalTestLog: "tests passed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    artifactExpiresAt: "2099-01-01T00:00:00.000Z"
  };
}
