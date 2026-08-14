export type OpenRouterEndpoint = {
  tag?: string;
  name?: string;
  context_length?: number;
  uptime_last_30m?: number;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  data_policy?: {
    training?: boolean;
  };
};

function numericPrice(value: string | undefined): number {
  const parsed = Number(value ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function selectProviders(endpoints: OpenRouterEndpoint[], limit = 2): string[] {
  return endpoints
    .filter((endpoint) => {
      const tools = endpoint.supported_parameters?.includes("tools") ?? false;
      const context = endpoint.context_length ?? 0;
      const noTraining = endpoint.data_policy?.training !== true;
      return tools && context >= 131_072 && noTraining && Boolean(endpoint.tag);
    })
    .sort((a, b) => {
      const uptime = (b.uptime_last_30m ?? 0) - (a.uptime_last_30m ?? 0);
      if (uptime !== 0) return uptime;
      const aPrice = numericPrice(a.pricing?.prompt) + numericPrice(a.pricing?.completion);
      const bPrice = numericPrice(b.pricing?.prompt) + numericPrice(b.pricing?.completion);
      return aPrice - bPrice;
    })
    .slice(0, limit)
    .map((endpoint) => endpoint.tag as string);
}
