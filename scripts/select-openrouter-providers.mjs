const modelId = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required for provider validation.");
  process.exit(1);
}

const [author, ...slugParts] = modelId.split("/");
const slug = slugParts.join("/");
if (!author || !slug) throw new Error("Invalid OPENROUTER_MODEL: " + modelId);

const response = await fetch(
  "https://openrouter.ai/api/v1/models/" + encodeURIComponent(author) + "/" + encodeURIComponent(slug) + "/endpoints",
  { headers: { Authorization: "Bearer " + apiKey } }
);
if (!response.ok) throw new Error("OpenRouter endpoints request failed with HTTP " + String(response.status));
const payload = await response.json();
const endpoints = Array.isArray(payload?.data?.endpoints) ? payload.data.endpoints : [];

const eligible = endpoints
  .filter((endpoint) =>
    Boolean(endpoint.tag) &&
    Number(endpoint.context_length || 0) >= 131072 &&
    Array.isArray(endpoint.supported_parameters) &&
    endpoint.supported_parameters.includes("tools") &&
    endpoint.data_policy?.training !== true
  )
  .sort((left, right) => {
    const uptime = Number(right.uptime_last_30m || 0) - Number(left.uptime_last_30m || 0);
    if (uptime !== 0) return uptime;
    return totalPrice(left) - totalPrice(right);
  });

const selected = eligible.slice(0, 2).map((endpoint) => endpoint.tag);
if (selected.length < 2) {
  throw new Error("Deployment blocked: fewer than two tool-capable 128K endpoints are available for " + modelId);
}

const configured = (process.env.OPENROUTER_PROVIDER_ORDER || "").split(",").map((value) => value.trim()).filter(Boolean);
if (process.env.VERCEL && (configured.length !== 2 || configured.some((tag) => !eligible.some((endpoint) => endpoint.tag === tag)))) {
  throw new Error("Deployment blocked: OPENROUTER_PROVIDER_ORDER must contain two currently eligible endpoint tags.");
}
console.log("Recommended OPENROUTER_PROVIDER_ORDER=" + selected.join(","));

function totalPrice(endpoint) {
  const prompt = Number(endpoint.pricing?.prompt ?? Number.POSITIVE_INFINITY);
  const completion = Number(endpoint.pricing?.completion ?? Number.POSITIVE_INFINITY);
  return prompt + completion;
}
