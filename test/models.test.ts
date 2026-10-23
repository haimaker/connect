import { describe, it, expect } from "vitest";
import { fetchModels, fetchModelCatalog, isChatModel, modelsToRegister } from "../src/models";

function mockFetch(body: any, status = 200) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("fetchModels", () => {
  it("filters wildcard rows and injects haimaker/auto first", async () => {
    const { impl, calls } = mockFetch({
      data: [
        { id: "*" },
        { id: "openai/*" },
        { id: "anthropic/*" },
        { id: "openai/gpt-4o" },
        { id: "anthropic/claude-3-5-sonnet" },
      ],
    });

    const models = await fetchModels("https://api.haimaker.ai", "sk-test", impl);

    expect(models[0]).toBe("haimaker/auto");
    expect(models).toContain("openai/gpt-4o");
    expect(models).toContain("anthropic/claude-3-5-sonnet");
    expect(models.some((m) => m.includes("*"))).toBe(false);

    // hits the /v1/models endpoint with a Bearer token
    expect(calls[0].url).toBe("https://api.haimaker.ai/v1/models");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-test");
  });

  it("dedupes haimaker/auto if it appears in the listing", async () => {
    const { impl } = mockFetch({
      data: [{ id: "haimaker/auto" }, { id: "openai/gpt-4o" }],
    });
    const models = await fetchModels("https://api.haimaker.ai", "sk-test", impl);
    expect(models.filter((m) => m === "haimaker/auto")).toHaveLength(1);
    expect(models[0]).toBe("haimaker/auto");
  });

  it("throws on non-200", async () => {
    const { impl } = mockFetch({}, 401);
    await expect(fetchModels("https://api.haimaker.ai", "bad", impl)).rejects.toThrow();
  });

  it("fails fast on a hanging endpoint (timeout)", async () => {
    const hanging = ((_url: string, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(
      fetchModels("https://api.haimaker.ai", "sk", hanging, 10)
    ).rejects.toThrow(/timed out/i);
  });

  it("rejects an oversized response (Content-Length) before parsing it", async () => {
    const huge = String(10 * 1024 * 1024); // 10 MB > 5 MB cap
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? huge : null) },
        json: async () => ({ data: [] }),
      } as unknown as Response)) as unknown as typeof fetch;
    await expect(fetchModels("https://api.haimaker.ai", "sk", impl)).rejects.toThrow(/too large/i);
  });
});

describe("fetchModelCatalog", () => {
  it("keeps API limits, drops non-chat models, and sorts after haimaker/auto", async () => {
    const { impl } = mockFetch({
      data: [
        { id: "openai/gpt-5", max_input_tokens: 400000, max_output_tokens: 128000 },
        { id: "openai/high/1024-x-1024/gpt-image-1" },
        { id: "openai/text-embedding-3-small" },
        { id: "openai/gpt-realtime" },
        { id: "anthropic/claude-sonnet-5", max_input_tokens: "lots", max_output_tokens: -1 },
        { id: "openai/gpt-5" },
      ],
    });
    const catalog = await fetchModelCatalog("https://api.haimaker.ai", "sk", impl);
    expect(catalog).toEqual([
      { id: "haimaker/auto" },
      { id: "anthropic/claude-sonnet-5" },
      { id: "openai/gpt-5", contextWindow: 400000, maxOutputTokens: 128000 },
    ]);
  });
});

describe("isChatModel", () => {
  it.each([
    ["deepseek/deepseek-v4-flash", true],
    ["openai/gpt-5", true],
    ["qwen/qwen3-coder", true],
    ["google/gemini-3-pro-image", false],
    ["openai/tts-1-hd", false],
    ["openai/gpt-4o-mini-tts", false],
    ["openai/whisper-1", false],
    ["openai/gpt-4o-mini-transcribe", false],
    ["openai/omni-moderation-latest", false],
    ["xai/grok-imagine-video", false],
    ["openai/hd/1024-x-1792/dall-e-3", false],
    ["cohere/rerank-v3.5", false],
  ])("%s -> %s", (id, expected) => {
    expect(isChatModel(id)).toBe(expected);
  });
});

describe("modelsToRegister", () => {
  it("is just the selected model without a catalog", () => {
    expect(modelsToRegister("openai/gpt-5")).toEqual([{ id: "openai/gpt-5" }]);
  });

  it("puts a selected model the catalog lacks first", () => {
    const catalog = [{ id: "haimaker/auto" }, { id: "openai/gpt-5" }];
    expect(modelsToRegister("custom/model", catalog).map((m) => m.id)).toEqual([
      "custom/model",
      "haimaker/auto",
      "openai/gpt-5",
    ]);
    expect(modelsToRegister("openai/gpt-5", catalog)).toEqual(catalog);
  });
});
