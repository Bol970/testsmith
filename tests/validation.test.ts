import { describe, expect, it } from "vitest";
import { normalizeGitHubRepository, startJobSchema } from "../shared/validation.js";

describe("GitHub URL validation", () => {
  it("normalizes a public repository URL", () => {
    expect(normalizeGitHubRepository("https://github.com/openai/openai-node/"))
      .toBe("https://github.com/openai/openai-node.git");
  });

  it.each([
    "http://github.com/openai/openai-node",
    "https://gitlab.com/openai/openai-node",
    "https://github.com/openai/openai-node/tree/main",
    "https://user:pass@github.com/openai/openai-node",
    "git@github.com:openai/openai-node.git"
  ])("rejects %s", (value) => {
    expect(() => normalizeGitHubRepository(value)).toThrow();
  });

  it("enforces task and object shape", () => {
    expect(startJobSchema.safeParse({
      repositoryUrl: "https://github.com/a/b",
      task: "ab",
      mode: "tests_only",
      accessCode: "code"
    }).success).toBe(false);
    expect(startJobSchema.safeParse({
      repositoryUrl: "https://github.com/a/b",
      task: "valid",
      mode: "tests_only",
      accessCode: "code",
      injected: true
    }).success).toBe(false);
  });
});
