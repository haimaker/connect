import { describe, it, expect } from "vitest";
import { verifySurface } from "../src/verify";
import { Surface } from "../src/agents/types";

function mockFetch(status: number, body: any = {}) {
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

const cases: Array<{ surface: Surface; baseUrl: string; expectedUrl: string }> = [
  {
    surface: "messages",
    baseUrl: "https://api.haimaker.ai",
    expectedUrl: "https://api.haimaker.ai/v1/messages",
  },
  {
    surface: "chat",
    baseUrl: "https://api.haimaker.ai/v1",
    expectedUrl: "https://api.haimaker.ai/v1/chat/completions",
  },
  {
    surface: "responses",
    baseUrl: "https://api.haimaker.ai/v1",
    expectedUrl: "https://api.haimaker.ai/v1/responses",
  },
];

describe("verifySurface - 200 ok", () => {
  for (const c of cases) {
    it(`returns ok for ${c.surface} and hits ${c.expectedUrl}`, async () => {
      const { impl, calls } = mockFetch(200, { id: "x", object: "ok" });
      const res = await verifySurface({
        surface: c.surface,
        baseUrl: c.baseUrl,
        apiKey: "sk-test",
        model: "haimaker/auto",
        fetchImpl: impl,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(calls[0].url).toBe(c.expectedUrl);
      // key sent as Bearer
      expect(calls[0].init.headers.Authorization).toBe("Bearer sk-test");
    });
  }

  it("sends anthropic-version header on messages surface", async () => {
    const { impl, calls } = mockFetch(200, {});
    await verifySurface({
      surface: "messages",
      baseUrl: "https://api.haimaker.ai",
      apiKey: "sk-test",
      model: "haimaker/auto",
      fetchImpl: impl,
    });
    expect(calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("verifySurface - 400 autoRouterHint", () => {
  for (const c of cases) {
    it(`returns autoRouterHint on 400 for ${c.surface}`, async () => {
      const { impl } = mockFetch(400, { error: "bad" });
      const res = await verifySurface({
        surface: c.surface,
        baseUrl: c.baseUrl,
        apiKey: "sk-test",
        model: "haimaker/auto",
        fetchImpl: impl,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
      expect(res.autoRouterHint).toBe(true);
      expect(res.message).toContain("app.haimaker.ai/api-keys");
    });
  }

  it("does not set autoRouterHint on a 500", async () => {
    const { impl } = mockFetch(500, {});
    const res = await verifySurface({
      surface: "chat",
      baseUrl: "https://api.haimaker.ai/v1",
      apiKey: "sk-test",
      model: "haimaker/auto",
      fetchImpl: impl,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.autoRouterHint).toBeFalsy();
  });
});

describe("verifySurface - timeout", () => {
  it("fails fast instead of hanging when the endpoint never responds", async () => {
    // A fetch that only settles when its AbortSignal fires.
    const hanging = ((_url: string, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const res = await verifySurface({
      surface: "chat",
      baseUrl: "https://api.haimaker.ai/v1",
      apiKey: "sk-test",
      model: "haimaker/auto",
      fetchImpl: hanging,
      timeoutMs: 10,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/timed out|could not reach/i);
  });
});
