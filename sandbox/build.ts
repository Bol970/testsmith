import { fileURLToPath } from "node:url";
import { Template, defaultBuildLogger, waitForURL } from "e2b";

const context = fileURLToPath(new URL(".", import.meta.url));

const template = Template({ fileContextPath: context })
  .fromNodeImage("22")
  .setUser("root")
  .aptInstall(["git", "curl", "ca-certificates"])
  .makeDir(["/app", "/home/user/workspace", "/home/user/output"], { user: "root", mode: 0o750 })
  .runCmd("chown -R user:user /app /home/user/workspace /home/user/output", { user: "root" })
  .copy(["package.json", "package-lock.json"], "/app/", { user: "user", mode: 0o640 })
  .copy("dist/runner.mjs", "/app/runner.mjs", { user: "user", mode: 0o750 })
  .setWorkdir("/app")
  .runCmd("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { user: "user" })
  .runCmd([
    "corepack enable",
    "corepack prepare pnpm@10.15.0 --activate",
    "corepack prepare yarn@1.22.22 --activate",
    "git config --system advice.detachedHead false"
  ], { user: "root" })
  .setUser("user")
  .setStartCmd("node /app/runner.mjs", waitForURL("http://127.0.0.1:8080/healthz"));

const build = await Template.build(template, "testsmith-agent-v1", {
  cpuCount: 2,
  memoryMB: 2_048,
  onBuildLogs: defaultBuildLogger()
});

console.log("E2B template built:", build.name, build.templateId, build.buildId);
