import { describe, expect, it } from "vitest";
import { selectProviders } from "../shared/providers.js";

describe("provider selection", () => {
  it("requires the full Pi tool-call parameter set and 128K context, then sorts by uptime and price", () => {
    expect(selectProviders([
      endpoint("slow-cheap", 98, "0.000001"),
      endpoint("fast-expensive", 100, "0.01"),
      endpoint("fast-cheap", 100, "0.000002"),
      { ...endpoint("no-tools", 101, "0"), supported_parameters: [] },
      { ...endpoint("no-tool-choice", 101, "0"), supported_parameters: ["tools", "max_tokens"] },
      { ...endpoint("short", 101, "0"), context_length: 64_000 }
    ])).toEqual(["fast-cheap", "fast-expensive"]);
  });

  it("excludes endpoints that explicitly train on prompts", () => {
    expect(selectProviders([{ ...endpoint("training", 100, "0"), data_policy: { training: true } }]))
      .toEqual([]);
  });
});

function endpoint(tag: string, uptime: number, price: string) {
  return {
    tag,
    context_length: 131_072,
    uptime_last_30m: uptime,
    supported_parameters: ["tools", "tool_choice", "max_tokens"],
    pricing: { prompt: price, completion: price },
    data_policy: { training: false }
  };
}
