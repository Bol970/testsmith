const requiredKeys = [
  "E2B_API_KEY",
  "OPENROUTER_API_KEY",
  "ACCESS_CODE",
  "JOB_TOKEN_SECRET",
  "APP_ORIGIN"
] as const;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env) {
  const missing = requiredKeys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error("Missing server configuration: " + missing.join(", "));
  }

  const providerOrder = (env.OPENROUTER_PROVIDER_ORDER ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  if (providerOrder.length !== 2) {
    throw new Error("OPENROUTER_PROVIDER_ORDER must contain exactly two providers");
  }

  const appOrigin = new URL(env.APP_ORIGIN as string);
  if (!["http:", "https:"].includes(appOrigin.protocol)) {
    throw new Error("APP_ORIGIN must be an HTTP(S) URL");
  }

  const maxActiveJobs = Number(env.MAX_ACTIVE_JOBS ?? "2");
  if (!Number.isInteger(maxActiveJobs) || maxActiveJobs < 1 || maxActiveJobs > 20) {
    throw new Error("MAX_ACTIVE_JOBS must be an integer between 1 and 20");
  }

  return {
    e2bApiKey: env.E2B_API_KEY as string,
    openrouterApiKey: env.OPENROUTER_API_KEY as string,
    accessCode: env.ACCESS_CODE as string,
    jobTokenSecret: env.JOB_TOKEN_SECRET as string,
    appOrigin: appOrigin.origin,
    e2bTemplate: env.E2B_TEMPLATE || "testsmith-agent-v1",
    modelId: env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash",
    providerOrder,
    maxActiveJobs
  };
}
