import type { JobMode } from "./types.js";

const ignoredSegments = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache"
]);

const testDirectories = new Set([
  "test",
  "tests",
  "spec",
  "specs",
  "__tests__",
  "__snapshots__",
  "cypress",
  "playwright"
]);

const alwaysAllowedFiles = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".mocharc",
  ".mocharc.json",
  ".mocharc.js",
  ".mocharc.cjs",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "jest.config.ts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.ts",
  "playwright.config.js",
  "playwright.config.ts",
  "cypress.config.js",
  "cypress.config.ts"
]);

function normalizedSegments(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

export function isUnsafeArtifactPath(path: string): boolean {
  const segments = normalizedSegments(path);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const name = lowerSegments.at(-1) ?? "";
  return (
    path.startsWith("/") ||
    /^[a-z]:\//i.test(path.replaceAll("\\", "/")) ||
    path.includes("\0") ||
    segments.includes("..") ||
    lowerSegments.some((segment) => ignoredSegments.has(segment)) ||
    lowerSegments.some((segment) => segment === ".ssh" || segment === ".aws" || segment === ".gnupg") ||
    name === ".env" ||
    name.startsWith(".env.") ||
    /(?:^|[-_.])(secret|secrets|credential|credentials)(?:$|[-_.])/.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)
  );
}

export function isAllowedTestChange(path: string): boolean {
  if (isUnsafeArtifactPath(path)) return false;
  const segments = normalizedSegments(path);
  const name = segments.at(-1) ?? "";
  const lower = name.toLowerCase();

  if (segments.some((segment) => testDirectories.has(segment.toLowerCase()))) return true;
  if (alwaysAllowedFiles.has(lower)) return true;
  if (/(\.|-)(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return true;
  if (/^tsconfig[.-].*test.*\.json$/.test(lower)) return true;
  if (/\.(snap|stories\.[cm]?[jt]sx?)$/.test(lower)) return true;
  return false;
}

export function classifyChanges(paths: string[], mode: JobMode): {
  allowed: string[];
  excluded: string[];
} {
  const allowed: string[] = [];
  const excluded: string[] = [];

  for (const path of [...new Set(paths)].sort()) {
    const permitted =
      !isUnsafeArtifactPath(path) &&
      (mode === "tests_and_fix" || isAllowedTestChange(path));
    (permitted ? allowed : excluded).push(path);
  }

  return { allowed, excluded };
}
