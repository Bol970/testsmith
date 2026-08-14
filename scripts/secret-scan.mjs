import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const ignored = new Set([".git", "node_modules", "dist", "coverage", "playwright-report", "test-results"]);
const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".zip", ".woff", ".woff2"]);
const detectors = [
  { name: "OpenAI/OpenRouter key", regex: /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub token", regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "E2B key", regex: /\be2b_[A-Za-z0-9_-]{20,}\b/g }
];

const files = await projectFiles();
const findings = [];
for (const file of files) {
  if (binaryExtensions.has(extname(file).toLowerCase())) continue;
  let value;
  try {
    value = await readFile(file, "utf8");
  } catch {
    continue;
  }
  if (value.includes("\0")) continue;
  for (const detector of detectors) {
    detector.regex.lastIndex = 0;
    if (detector.regex.test(value)) findings.push(file + ": " + detector.name);
  }
}

if (findings.length) {
  console.error("Secret scan failed:\n" + findings.join("\n"));
  process.exit(1);
}
console.log("Secret scan passed (" + String(files.length) + " files checked).");

async function projectFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const listed = output.split("\n").filter(Boolean);
    if (listed.length) return listed;
  } catch {
    // The pre-commit scanner also works before git init.
  }
  const result = [];
  const pending = ["."];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path.replace(/^\.\//, ""));
    }
  }
  return result;
}
