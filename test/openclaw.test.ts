import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { makeTmpDir, cleanup } from "./helpers";
import { openclawWriter } from "../src/agents/openclaw";
import { InstallCtx, Scope } from "../src/agents/types";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-openclaw");
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) cleanup(dirs.pop()!);
});

const HOST = "https://api.haimaker.ai";
const KEY = "sk-secret-do-not-log-123";

function ctx(dir: string, overrides: Partial<InstallCtx> = {}): InstallCtx {
  return {
    scope: { kind: "user", dir },
    host: HOST,
    apiKey: KEY,
    model: "haimaker/auto",
    verify: false,
    ...overrides,
  };
}

function configFile(dir: string): string {
  return path.join(dir, ".openclaw", "openclaw.json");
}

function readJson(dir: string): any {
  return JSON.parse(fs.readFileSync(configFile(dir), "utf8"));
}

describe("openclawWriter metadata", () => {
  it("has the expected id / surface", () => {
    expect(openclawWriter.id).toBe("openclaw");
    expect(openclawWriter.surface).toBe("chat");
  });
});

describe("configPath honors scope.dir", () => {
  it("resolves the config under scope.dir, not the real home", () => {
    const dir = tmp();
    expect(openclawWriter.configPath({ kind: "user", dir })).toBe(configFile(dir));
  });
});

describe("detect", () => {
  it("is false when ~/.openclaw does not exist", async () => {
    const dir = tmp();
    expect(await openclawWriter.detect({ kind: "user", dir })).toBe(false);
  });

  it("is true when ~/.openclaw exists", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".openclaw"));
    expect(await openclawWriter.detect({ kind: "user", dir })).toBe(true);
  });
});

describe("configure - fresh install", () => {
  it("writes the expected provider + default model", async () => {
    const dir = tmp();
    await openclawWriter.configure(ctx(dir));

    const obj = readJson(dir);
    expect(obj.agents.defaults.model.primary).toBe("haimaker/auto");

    const prov = obj.models.providers.haimaker;
    expect(prov.baseUrl).toBe("https://api.haimaker.ai/v1");
    expect(prov.apiKey).toBe(KEY);
    expect(prov.api).toBe("openai-completions");
    expect(prov.models).toEqual([
      { id: "auto", name: "Haimaker Auto", contextWindow: 200000, maxTokens: 8192 },
    ]);
  });

  it("writes the secret-bearing file with mode 0600", async () => {
    const dir = tmp();
    await openclawWriter.configure(ctx(dir));
    const st = fs.statSync(configFile(dir));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("derives a chat base URL (host + /v1, never /v1/v1) even from a messy host", async () => {
    const dir = tmp();
    // ctx.host is normally pre-normalized; baseUrlForSurface re-normalizes anyway.
    await openclawWriter.configure(ctx(dir, { host: "https://api.haimaker.ai/v1/" }));
    expect(readJson(dir).models.providers.haimaker.baseUrl).toBe(
      "https://api.haimaker.ai/v1"
    );
  });
});

describe("configure - idempotency", () => {
  it("re-running does not duplicate the provider or block", async () => {
    const dir = tmp();
    await openclawWriter.configure(ctx(dir));
    const first = fs.readFileSync(configFile(dir), "utf8");
    await openclawWriter.configure(ctx(dir));
    const second = fs.readFileSync(configFile(dir), "utf8");

    expect(second).toBe(first);

    const obj = readJson(dir);
    // Single provider object, single auto model entry.
    expect(Object.keys(obj.models.providers)).toEqual(["haimaker"]);
    expect(obj.models.providers.haimaker.models).toHaveLength(1);
  });
});

describe("configure - preserves unrelated config", () => {
  it("keeps other providers, agent settings, and top-level keys", async () => {
    const dir = tmp();
    const f = configFile(dir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      `{
        // user comment (will be dropped on rewrite - accepted v1 tradeoff)
        "agents": { "defaults": { "model": { "primary": "old/model", "fallback": "keep/me" } }, "custom": true },
        "models": { "providers": { "openai": { "apiKey": "OTHER-KEY" } } },
        "theme": "dark"
      }`
    );

    await openclawWriter.configure(ctx(dir));

    const obj = readJson(dir);
    // Our provider is applied; the user's existing (non-haimaker) default model
    // is PRESERVED, not clobbered.
    expect(obj.agents.defaults.model.primary).toBe("old/model");
    expect(obj.models.providers.haimaker.api).toBe("openai-completions");
    // Everything unrelated preserved.
    expect(obj.agents.defaults.model.fallback).toBe("keep/me");
    expect(obj.agents.custom).toBe(true);
    expect(obj.models.providers.openai.apiKey).toBe("OTHER-KEY");
    expect(obj.theme).toBe("dark");
  });
});

describe("uninstall", () => {
  it("removes exactly our provider and resets a haimaker default, leaving the rest", async () => {
    const dir = tmp();
    const f = configFile(dir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // No pre-existing primary -> configure will set ours (haimaker/auto).
    fs.writeFileSync(
      f,
      JSON.stringify({
        agents: { defaults: { model: { fallback: "keep/me" } } },
        models: { providers: { openai: { apiKey: "OTHER-KEY" } } },
        theme: "dark",
      })
    );

    await openclawWriter.configure(ctx(dir));
    await openclawWriter.uninstall({ kind: "user", dir });

    const obj = readJson(dir);
    // Our provider is gone, the other provider survives.
    expect(obj.models.providers.haimaker).toBeUndefined();
    expect(obj.models.providers.openai.apiKey).toBe("OTHER-KEY");
    // primary was "haimaker/auto" -> reset; fallback + theme preserved.
    expect(obj.agents.defaults.model.primary).toBeUndefined();
    expect(obj.agents.defaults.model.fallback).toBe("keep/me");
    expect(obj.theme).toBe("dark");
  });

  it("preserves a user's pre-existing non-haimaker default through configure + uninstall", async () => {
    const dir = tmp();
    const f = configFile(dir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-4o" } } } })
    );

    // configure must NOT overwrite the user's chosen default...
    await openclawWriter.configure(ctx(dir));
    expect(readJson(dir).agents.defaults.model.primary).toBe("openai/gpt-4o");

    // ...and uninstall must NOT reset it (it was never ours).
    await openclawWriter.uninstall({ kind: "user", dir });
    const obj = readJson(dir);
    expect(obj.models?.providers?.haimaker).toBeUndefined();
    expect(obj.agents.defaults.model.primary).toBe("openai/gpt-4o");
  });

  it("is a no-op when the config file is absent", async () => {
    const dir = tmp();
    await openclawWriter.uninstall({ kind: "user", dir });
    expect(fs.existsSync(configFile(dir))).toBe(false);
  });
});

describe("verify - chat surface (no live network)", () => {
  it("posts to /v1/chat/completions and reports ok", async () => {
    const dir = tmp();
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string, init: any) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "x", object: "chat.completion" }),
        } as unknown as Response;
      }) as unknown as typeof fetch
    );

    const res = await openclawWriter.verify(ctx(dir));

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.haimaker.ai/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});
