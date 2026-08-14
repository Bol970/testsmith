export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export function detectPackageManager(files: Iterable<string>): PackageManager {
  const names = new Set([...files]);
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) return "npm";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (names.has("package.json")) return "npm";
  return "unknown";
}

export function installCommand(manager: PackageManager, hasLock: boolean): string | null {
  if (manager === "pnpm") return hasLock ? "pnpm install --frozen-lockfile" : "pnpm install";
  if (manager === "yarn") return hasLock ? "yarn install --immutable" : "yarn install";
  if (manager === "npm") return hasLock ? "npm ci" : "npm install --no-package-lock";
  return null;
}

export function testCommand(manager: PackageManager): string | null {
  if (manager === "pnpm") return "pnpm test";
  if (manager === "yarn") return "yarn test";
  if (manager === "npm") return "npm test";
  return null;
}
