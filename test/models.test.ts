import { describe, it, expect } from "vitest";
import { fetchModels } from "../src/models";

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
