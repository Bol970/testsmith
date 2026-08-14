import { z } from "zod";
import { jobModes } from "./types.js";

const githubOwner = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?";
const githubRepo = "[A-Za-z0-9_.-]{1,100}";
const githubPattern = new RegExp("^https://github\\.com/(" + githubOwner + ")/(" + githubRepo + "?)(?:\\.git)?/?$");

export const startJobSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(300),
  task: z.string().trim().min(3).max(2000),
  mode: z.enum(jobModes),
  accessCode: z.string().min(1).max(256)
}).strict();

export function normalizeGitHubRepository(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Укажите корректный URL репозитория GitHub");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  ) {
    throw new Error("Поддерживаются только публичные HTTPS-репозитории github.com");
  }

  const canonical = "https://github.com" + url.pathname;
  const match = canonical.match(githubPattern);
  if (!match) {
    throw new Error("URL должен иметь вид https://github.com/owner/repository");
  }

  return "https://github.com/" + match[1] + "/" + match[2].replace(/\.git$/i, "") + ".git";
}
