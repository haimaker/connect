import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTmpDir, cleanup } from "./helpers";
import { clineWriter } from "../src/agents/cline";
import { InstallCtx, Scope } from "../src/agents/types";

const HOST = "https://api.haimaker.ai";
const KEY = "sk-secret-do-not-leak";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-cline");
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) cleanup(dirs.pop()!);
});

function ctx(dir: string, over: Partial<InstallCtx> = {}): InstallCtx {
  return { scope: { kind: "user", dir }, host: HOST, apiKey: KEY, model: "haimaker/auto", verify: false, ...over };
}
function cfgPath(dir: string): string {
  return path.join(dir, ".cline", "data", "settings", "providers.json");
}
function read(dir: string): any {
  return JSON.parse(fs.readFileSync(cfgPath(dir), "utf8"));
}

describe("clineWriter metadata", () => {
  it("has the expected id/surface", () => {
    expect(clineWriter.id).toBe("cline");
    expect(clineWriter.surface).toBe("chat");
  });

  it("resolves providers.json under scope.dir", () => {
    const dir = tmp();
    expect(clineWriter.configPath({ kind: "user", dir })).toBe(cfgPath(dir));
  });
});

describe("clineWriter.detect", () => {
  it("is false when ~/.cline is absent, true once it exists", async () => {
    const dir = tmp();
    expect(await clineWriter.detect({ kind: "user", dir })).toBe(false);
    fs.mkdirSync(path.join(dir, ".cline"));
    expect(await clineWriter.detect({ kind: "user", dir })).toBe(true);
  });
});

describe("clineWriter.configure", () => {
  it("writes the schema-valid openai-compatible provider", async () => {
    const dir = tmp();
    await clineWriter.configure(ctx(dir));
    const cfg = read(dir);

    expect(cfg.version).toBe(1);
    expect(cfg.lastUsedProvider).toBe("openai-compatible");
    const entry = cfg.providers["openai-compatible"];
    expect(entry.settings).toEqual({
      provider: "openai-compatible",
      apiKey: KEY,
      model: "haimaker/auto",
      baseUrl: "https://api.haimaker.ai/v1", // chat surface -> host + /v1
    });
    expect(entry.tokenSource).toBe("manual");
    // updatedAt is REQUIRED by Cline's schema.
    expect(typeof entry.updatedAt).toBe("string");
    expect(() => new Date(entry.updatedAt).toISOString()).not.toThrow();
  });

  it("writes the secret-bearing file with mode 0600", async () => {
    const dir = tmp();
    await clineWriter.configure(ctx(dir));
    expect(fs.statSync(cfgPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("passes a concrete --model straight through (Haimaker model name)", async () => {
    const dir = tmp();
    await clineWriter.configure(ctx(dir, { model: "openai/gpt-4o" }));
    expect(read(dir).providers["openai-compatible"].settings.model).toBe("openai/gpt-4o");
  });

  it("preserves a pre-existing unrelated provider", async () => {
    const dir = tmp();
    const p = cfgPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        lastUsedProvider: "anthropic",
        providers: { anthropic: { settings: { provider: "anthropic", apiKey: "sk-other" }, tokenSource: "manual" } },
      })
    );

    await clineWriter.configure(ctx(dir));
    const cfg = read(dir);
    expect(cfg.providers.anthropic.settings.apiKey).toBe("sk-other");
    expect(cfg.providers["openai-compatible"].settings.baseUrl).toBe("https://api.haimaker.ai/v1");
    expect(cfg.lastUsedProvider).toBe("openai-compatible"); // we select ours
  });
});

describe("clineWriter.uninstall", () => {
  it("removes our openai-compatible slot and lastUsedProvider, leaving others", async () => {
    const dir = tmp();
    const p = cfgPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        providers: { anthropic: { settings: { provider: "anthropic", apiKey: "sk-other" } } },
      })
    );

    await clineWriter.configure(ctx(dir));
    await clineWriter.uninstall({ kind: "user", dir });

    const cfg = read(dir);
    expect(cfg.providers["openai-compatible"]).toBeUndefined();
    expect(cfg.providers.anthropic.settings.apiKey).toBe("sk-other");
    expect(cfg.lastUsedProvider).toBeUndefined();
  });

  it("leaves a user's NON-haimaker openai-compatible slot untouched", async () => {
    const dir = tmp();
    const p = cfgPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        lastUsedProvider: "openai-compatible",
        providers: {
          "openai-compatible": {
            settings: { provider: "openai-compatible", apiKey: "sk-mine", model: "x", baseUrl: "https://api.example.com/v1" },
            tokenSource: "manual",
          },
        },
      })
    );

    await clineWriter.uninstall({ kind: "user", dir });
    const cfg = read(dir);
    // Not ours (different baseUrl) -> preserved.
    expect(cfg.providers["openai-compatible"].settings.baseUrl).toBe("https://api.example.com/v1");
  });

  it("is a no-op when the file is absent", async () => {
    const dir = tmp();
    await expect(clineWriter.uninstall({ kind: "user", dir })).resolves.toBeUndefined();
    expect(fs.existsSync(cfgPath(dir))).toBe(false);
  });
});

describe("clineWriter.verify (mocked fetch, no network)", () => {
  it("probes the chat-completions surface", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string, init: any) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
      }) as unknown as typeof fetch
    );
    const res = await clineWriter.verify(ctx(tmp(), { verify: true }));
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.haimaker.ai/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});
