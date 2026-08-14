import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import lockfile from "proper-lockfile";

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

function resolvePiStoredLiteral(value: string): string {
  if (value.startsWith("!")) throw new Error("command values are not literals");
  let resolved = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "$") {
      resolved += value[i];
      continue;
    }
    const escaped = value[++i];
    if (escaped !== "$" && escaped !== "!") {
      throw new Error("test resolver only accepts Pi's literal escape sequences");
    }
    resolved += escaped;
  }
  return resolved;
}

function expectPiModelsSchema(config: Record<string, any>): void {
  expect(config).toEqual(expect.any(Object));
  expect(config.providers).toEqual(expect.any(Object));
  for (const provider of Object.values(config.providers) as Array<Record<string, any>>) {
    expect(provider.baseUrl).toEqual(expect.any(String));
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toEqual(expect.any(Array));
    for (const model of provider.models) {
      expect(model).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        reasoning: expect.any(Boolean),
        input: expect.any(Array),
        contextWindow: expect.any(Number),
        maxTokens: expect.any(Number),
        cost: {
          input: expect.any(Number),
          output: expect.any(Number),
          cacheRead: expect.any(Number),
          cacheWrite: expect.any(Number),
        },
      });
    }
  }
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

  it("matches Pi by preserving a relative PI_CODING_AGENT_DIR", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "relative-agent-dir");

    expect(piWriter.configPath({ kind: "user" })).toBe(
      path.join("relative-agent-dir", "models.json")
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
          models: [
            {
              id: "auto",
              name: "Haimaker Auto",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 32768,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    });
    expect(readConfig(dir, "auth.json")).toEqual({
      haimaker: { type: "api_key", key: KEY },
    });
    expect(readConfig(dir, "settings.json")).toEqual({
      defaultProvider: "haimaker",
      defaultModel: "auto",
    });
    expectPiModelsSchema(readConfig(dir, "models.json"));
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
      {
        id: "openai/gpt-4o",
        name: "Haimaker openai/gpt-4o",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    expect(readConfig(dir, "settings.json").defaultModel).toBe("openai/gpt-4o");
  });

  it("escapes Pi credential interpolation syntax so keys remain literal", async () => {
    const dir = tmp();
    const original = "!secret-$TOKEN";
    await piWriter.configure(ctx(dir, { apiKey: original }));

    const stored = readConfig(dir, "auth.json").haimaker.key;
    expect(stored).toBe("$!secret-$$TOKEN");
    expect(resolvePiStoredLiteral(stored)).toBe(original);
  });

  it("preserves Pi's environment snapshot on an existing credential", async () => {
    const dir = tmp();
    fs.mkdirSync(agentDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir(dir), "auth.json"),
      JSON.stringify({
        haimaker: { type: "api_key", key: "old", env: { KEY_PREFIX: "saved", COUNT: "2" } },
      })
    );

    await piWriter.configure(ctx(dir));

    expect(readConfig(dir, "auth.json").haimaker).toEqual({
      type: "api_key",
      key: KEY,
      env: { KEY_PREFIX: "saved", COUNT: "2" },
    });
  });

  it("waits for Pi's auth.json lock and preserves the competing update", async () => {
    const dir = tmp();
    const authFile = path.join(agentDir(dir), "auth.json");
    fs.mkdirSync(agentDir(dir), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key", key: "one" } }));
    const release = await lockfile.lock(authFile, { realpath: false });
    setTimeout(() => {
      fs.writeFileSync(
        authFile,
        JSON.stringify({
          openai: { type: "api_key", key: "one" },
          anthropic: { type: "api_key", key: "two" },
        })
      );
      void release();
    }, 50);

    await piWriter.configure(ctx(dir));

    expect(readConfig(dir, "auth.json")).toMatchObject({
      openai: { type: "api_key", key: "one" },
      anthropic: { type: "api_key", key: "two" },
      haimaker: { type: "api_key", key: KEY },
    });
  });

  it("is idempotent and updates a default it already owns", async () => {
    const dir = tmp();
    await piWriter.configure(ctx(dir));
    await piWriter.configure(ctx(dir, { model: "deepseek/deepseek-v3" }));

    const models = readConfig(dir, "models.json");
    expect(Object.keys(models.providers)).toEqual(["haimaker"]);
    expect(models.providers.haimaker.models).toEqual([
      {
        id: "deepseek/deepseek-v3",
        name: "Haimaker deepseek/deepseek-v3",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
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
  it("leaves the required providers object when Haimaker was the sole provider", async () => {
    const dir = tmp();
    await piWriter.configure(ctx(dir));
    await piWriter.uninstall({ kind: "user", dir });

    expect(readConfig(dir, "models.json")).toEqual({ providers: {} });
    expect(readConfig(dir, "auth.json")).toEqual({});
    expect(readConfig(dir, "settings.json")).toEqual({});
    expectPiModelsSchema(readConfig(dir, "models.json"));
  });

  it("scrubs the Haimaker key from the auth backup after repeated configure runs", async () => {
    const dir = tmp();
    const authBackup = path.join(agentDir(dir), "auth.json.haimaker.bak");
    await piWriter.configure(ctx(dir));
    await piWriter.configure(ctx(dir));
    expect(fs.readFileSync(authBackup, "utf8")).not.toContain(KEY);

    await piWriter.uninstall({ kind: "user", dir });

    expect(fs.readFileSync(authBackup, "utf8")).not.toContain(KEY);
    expect(JSON.parse(fs.readFileSync(authBackup, "utf8"))).toEqual({});
  });

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

  it("preserves an unrecognized default selected under the Haimaker provider", async () => {
    const dir = tmp();
    fs.mkdirSync(agentDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir(dir), "settings.json"),
      JSON.stringify({ defaultProvider: "haimaker", defaultModel: "user-managed-model" })
    );

    await piWriter.configure(ctx(dir));
    expect(readConfig(dir, "settings.json").defaultModel).toBe("user-managed-model");
    await piWriter.uninstall({ kind: "user", dir });

    expect(readConfig(dir, "settings.json")).toEqual({
      defaultProvider: "haimaker",
      defaultModel: "user-managed-model",
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
    expect(JSON.parse(calls[0].init.body).model).toBe("auto");
  });
});
