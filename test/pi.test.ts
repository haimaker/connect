import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { piWriter } from "../src/agents/pi";
import { InstallCtx, Scope } from "../src/agents/types";
import { cleanup, makeTmpDir } from "./helpers";

const HOST = "https://api.haimaker.ai";
const KEY = "sk-secret-do-not-log-123";

const dirs: string[] = [];
function tmp(): string {
  const dir = makeTmpDir("connect-pi");
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

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

function agentDir(dir: string): string {
  return path.join(dir, ".pi", "agent");
}

function readConfig(dir: string, name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(agentDir(dir), name), "utf8"));
}

describe("piWriter metadata and detection", () => {
  it("uses Pi's Chat Completions surface and native models path", () => {
    const dir = tmp();
    expect(piWriter.id).toBe("pi");
    expect(piWriter.displayName).toBe("Pi");
    expect(piWriter.surface).toBe("chat");
    expect(piWriter.configPath({ kind: "user", dir })).toBe(
      path.join(agentDir(dir), "models.json")
    );
  });

  it("detects Pi's user agent directory", async () => {
    const dir = tmp();
    const scope: Scope = { kind: "user", dir };
    expect(await piWriter.detect(scope)).toBe(false);
    fs.mkdirSync(agentDir(dir), { recursive: true });
    expect(await piWriter.detect(scope)).toBe(true);
  });

  it("honors PI_CODING_AGENT_DIR while keeping scope.dir as the test override", () => {
    const dir = tmp();
    const configured = path.join(dir, "custom-agent-dir");
    vi.stubEnv("PI_CODING_AGENT_DIR", configured);

    expect(piWriter.configPath({ kind: "user" })).toBe(path.join(configured, "models.json"));
    expect(piWriter.configPath({ kind: "user", dir })).toBe(
      path.join(dir, ".pi", "agent", "models.json")
    );
  });

  it("rejects a relative PI_CODING_AGENT_DIR instead of writing relative to cwd", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "relative-agent-dir");

    expect(() => piWriter.configPath({ kind: "user" })).toThrow(
      /PI_CODING_AGENT_DIR must be an absolute path/i
    );
  });
});

describe("piWriter configure", () => {
  it("writes a native provider, credential, and default selection", async () => {
    const dir = tmp();
    await piWriter.configure(ctx(dir));

    expect(readConfig(dir, "models.json")).toEqual({
      providers: {
        haimaker: {
          name: "Haimaker",
          baseUrl: "https://api.haimaker.ai/v1",
          api: "openai-completions",
          models: [{ id: "haimaker/auto", name: "Haimaker Auto" }],
        },
      },
    });
    expect(readConfig(dir, "auth.json")).toEqual({
      haimaker: { type: "api_key", key: KEY },
    });
    expect(readConfig(dir, "settings.json")).toEqual({
      defaultProvider: "haimaker",
      defaultModel: "haimaker/auto",
    });
  });

  it("writes all three files with mode 0600", async () => {
    const dir = tmp();
    await piWriter.configure(ctx(dir));

    for (const name of ["models.json", "auth.json", "settings.json"]) {
      expect(fs.statSync(path.join(agentDir(dir), name)).mode & 0o777).toBe(0o600);
    }
  });

  it("tightens pre-existing files from 0644 to 0600", async () => {
    const dir = tmp();
    fs.mkdirSync(agentDir(dir), { recursive: true });
    for (const name of ["models.json", "auth.json", "settings.json"]) {
      const file = path.join(agentDir(dir), name);
      fs.writeFileSync(file, "{}\n");
      fs.chmodSync(file, 0o644);
    }

    await piWriter.configure(ctx(dir));

    for (const name of ["models.json", "auth.json", "settings.json"]) {
      expect(fs.statSync(path.join(agentDir(dir), name)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails clearly and preserves a malformed providers value", async () => {
    const dir = tmp();
    fs.mkdirSync(agentDir(dir), { recursive: true });
    const modelsPath = path.join(agentDir(dir), "models.json");
    const original = JSON.stringify({ providers: "invalid", keep: true });
    fs.writeFileSync(modelsPath, original);

    await expect(piWriter.configure(ctx(dir))).rejects.toThrow(
      /models\.json "providers" must contain a JSON object/i
    );
    expect(fs.readFileSync(modelsPath, "utf8")).toBe(original);
    expect(fs.readFileSync(`${modelsPath}.haimaker.bak`, "utf8")).toBe(original);
  });

  it("uses the selected upstream model id and normalizes the base URL", async () => {
    const dir = tmp();
    await piWriter.configure(
      ctx(dir, { model: "openai/gpt-4o", host: "https://api.haimaker.ai/v1/" })
    );

    const provider = readConfig(dir, "models.json").providers.haimaker;
    expect(provider.baseUrl).toBe("https://api.haimaker.ai/v1");
    expect(provider.models).toEqual([
      { id: "openai/gpt-4o", name: "Haimaker openai/gpt-4o" },
    ]);
    expect(readConfig(dir, "settings.json").defaultModel).toBe("openai/gpt-4o");
  });

  it("escapes Pi credential interpolation syntax so keys remain literal", async () => {
    const dir = tmp();
    await piWriter.configure(ctx(dir, { apiKey: "!secret-$TOKEN" }));

    expect(readConfig(dir, "auth.json").haimaker.key).toBe("$!secret-$$TOKEN");
  });

  it("is idempotent and updates a default it already owns", async () => {
    const dir = tmp();
    await piWriter.configure(ctx(dir));
    await piWriter.configure(ctx(dir, { model: "deepseek/deepseek-v3" }));

    const models = readConfig(dir, "models.json");
    expect(Object.keys(models.providers)).toEqual(["haimaker"]);
    expect(models.providers.haimaker.models).toEqual([
      { id: "deepseek/deepseek-v3", name: "Haimaker deepseek/deepseek-v3" },
    ]);
    expect(readConfig(dir, "settings.json")).toEqual({
      defaultProvider: "haimaker",
      defaultModel: "deepseek/deepseek-v3",
    });
  });

  it("preserves unrelated providers, credentials, settings, and user defaults", async () => {
    const dir = tmp();
    fs.mkdirSync(agentDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir(dir), "models.json"),
      JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost:11434/v1" } }, note: true })
    );
    fs.writeFileSync(
      path.join(agentDir(dir), "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "other-key" } })
    );
    fs.writeFileSync(
      path.join(agentDir(dir), "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet", theme: "light" })
    );

    await piWriter.configure(ctx(dir));

    expect(readConfig(dir, "models.json").providers.ollama.baseUrl).toBe(
      "http://localhost:11434/v1"
    );
    expect(readConfig(dir, "models.json").note).toBe(true);
    expect(readConfig(dir, "auth.json").openai.key).toBe("other-key");
    expect(readConfig(dir, "settings.json")).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet",
      theme: "light",
    });
  });
});

describe("piWriter uninstall", () => {
  it("removes only Haimaker-owned entries", async () => {
    const dir = tmp();
    fs.mkdirSync(agentDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir(dir), "models.json"),
      JSON.stringify({ providers: { ollama: { api: "openai-completions" } } })
    );
    fs.writeFileSync(
      path.join(agentDir(dir), "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "other-key" } })
    );
    fs.writeFileSync(path.join(agentDir(dir), "settings.json"), JSON.stringify({ theme: "dark" }));

    await piWriter.configure(ctx(dir));
    await piWriter.uninstall({ kind: "user", dir });

    expect(readConfig(dir, "models.json")).toEqual({
      providers: { ollama: { api: "openai-completions" } },
    });
    expect(readConfig(dir, "auth.json")).toEqual({
      openai: { type: "api_key", key: "other-key" },
    });
    expect(readConfig(dir, "settings.json")).toEqual({ theme: "dark" });
  });

  it("does not remove a user-selected non-Haimaker default", async () => {
    const dir = tmp();
    fs.mkdirSync(agentDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir(dir), "settings.json"),
      JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5" })
    );

    await piWriter.configure(ctx(dir));
    await piWriter.uninstall({ kind: "user", dir });

    expect(readConfig(dir, "settings.json")).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
  });

  it("is a no-op when Pi's files are absent", async () => {
    const dir = tmp();
    await piWriter.uninstall({ kind: "user", dir });
    expect(fs.existsSync(agentDir(dir))).toBe(false);
  });
});

describe("piWriter verify", () => {
  it("posts to the Chat Completions endpoint", async () => {
    const dir = tmp();
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string, init: any) => {
        calls.push({ url, init });
        return {
          status: 200,
          json: async () => ({ id: "x", object: "chat.completion" }),
        } as Response;
      }) as typeof fetch
    );

    const result = await piWriter.verify(ctx(dir));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.haimaker.ai/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});
