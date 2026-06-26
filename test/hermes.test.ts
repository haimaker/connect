import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";

import { makeTmpDir, cleanup } from "./helpers";
import { hermesWriter } from "../src/agents/hermes";
import { InstallCtx } from "../src/agents/types";

const HOST = "https://api.haimaker.ai";
const KEY = "hm-secret-do-not-leak-123";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-hermes");
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) cleanup(dirs.pop()!);
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

function yamlPath(dir: string): string {
  return path.join(dir, ".hermes", "config.yaml");
}
function envPath(dir: string): string {
  return path.join(dir, ".hermes", ".env");
}
function readYaml(dir: string): any {
  return YAML.parse(fs.readFileSync(yamlPath(dir), "utf8"));
}
function readEnv(dir: string): string {
  return fs.readFileSync(envPath(dir), "utf8");
}
function haimakerProvider(cfg: any): any {
  return (cfg.custom_providers || []).find((p: any) => p.name === "haimaker");
}

describe("hermesWriter metadata", () => {
  it("is a chat-surface writer", () => {
    expect(hermesWriter.id).toBe("hermes");
    expect(hermesWriter.surface).toBe("chat");
  });

  it("resolves configPath under scope.dir (never a real home)", () => {
    const dir = tmp();
    expect(hermesWriter.configPath({ kind: "user", dir })).toBe(yamlPath(dir));
  });
});

describe("hermesWriter.detect", () => {
  it("is false when ~/.hermes is absent, true once it exists", async () => {
    const dir = tmp();
    expect(await hermesWriter.detect({ kind: "user", dir })).toBe(false);
    fs.mkdirSync(path.join(dir, ".hermes"));
    expect(await hermesWriter.detect({ kind: "user", dir })).toBe(true);
  });
});

describe("hermesWriter.configure - fresh install", () => {
  it("registers the haimaker custom provider and points Hermes at it", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir));

    const cfg = readYaml(dir);
    expect(haimakerProvider(cfg)).toEqual({
      name: "haimaker",
      base_url: "https://api.haimaker.ai/v1",
      api_mode: "chat_completions",
      key_env: "HAIMAKER_API_KEY",
      model: "haimaker/auto",
    });
    expect(cfg.model.provider).toBe("custom:haimaker");
    expect(cfg.model.default).toBe("haimaker/auto");
  });

  it("puts the secret in .env (0600), never in config.yaml", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir));

    expect(readEnv(dir)).toContain(`HAIMAKER_API_KEY=${KEY}`);
    expect(fs.statSync(envPath(dir)).mode & 0o777).toBe(0o600);

    const raw = fs.readFileSync(yamlPath(dir), "utf8");
    expect(raw).toContain("key_env: HAIMAKER_API_KEY");
    expect(raw).not.toContain(KEY);
  });

  it("derives the chat base URL even from a messy host (host + /v1, never /v1/v1)", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir, { host: "https://api.haimaker.ai/v1/" }));
    expect(haimakerProvider(readYaml(dir)).base_url).toBe("https://api.haimaker.ai/v1");
  });

  it("is idempotent: re-running keeps a single provider entry and one env line", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir));
    await hermesWriter.configure(ctx(dir));

    const cfg = readYaml(dir);
    expect(cfg.custom_providers.filter((p: any) => p.name === "haimaker")).toHaveLength(1);
    const envLines = readEnv(dir).split("\n").filter((l) => l.startsWith("HAIMAKER_API_KEY="));
    expect(envLines).toHaveLength(1);
  });

  it("a concrete --model is written through, still owned via the provider selector", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir, { model: "openai/gpt-4o" }));
    const cfg = readYaml(dir);
    expect(haimakerProvider(cfg).model).toBe("openai/gpt-4o");
    expect(cfg.model.default).toBe("openai/gpt-4o");
    expect(cfg.model.provider).toBe("custom:haimaker");
  });
});

describe("hermesWriter.configure - preserves the user's config", () => {
  it("keeps comments, other providers, and a user-chosen active provider", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".hermes"));
    fs.writeFileSync(
      yamlPath(dir),
      [
        "# my hermes config",
        "model:",
        "  provider: openai   # I use openai normally",
        "  temperature: 0.7",
        "custom_providers:",
        "  - name: local",
        "    base_url: http://localhost:8080/v1",
        "",
      ].join("\n")
    );
    fs.writeFileSync(envPath(dir), "OPENAI_API_KEY=sk-existing\n");

    await hermesWriter.configure(ctx(dir));

    const raw = fs.readFileSync(yamlPath(dir), "utf8");
    expect(raw).toContain("# my hermes config");
    expect(raw).toContain("# I use openai normally");

    const cfg = readYaml(dir);
    expect(cfg.custom_providers.map((p: any) => p.name)).toEqual(["local", "haimaker"]);
    // We do NOT clobber a user-chosen active provider.
    expect(cfg.model.provider).toBe("openai");
    expect(cfg.model.temperature).toBe(0.7);

    const env = readEnv(dir);
    expect(env).toContain("OPENAI_API_KEY=sk-existing");
    expect(env).toContain(`HAIMAKER_API_KEY=${KEY}`);
  });

  it("activates over Hermes' factory-default 'auto' provider", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".hermes"));
    fs.writeFileSync(
      yamlPath(dir),
      "model:\n  provider: auto\n  base_url: https://openrouter.ai/api/v1\n"
    );

    await hermesWriter.configure(ctx(dir));

    const cfg = readYaml(dir);
    // "auto" is the default, not a deliberate choice -> we point Hermes at us.
    expect(cfg.model.provider).toBe("custom:haimaker");
    expect(cfg.model.default).toBe("haimaker/auto");
    expect(haimakerProvider(cfg)).toBeTruthy();
  });

  it("inline key mode embeds api_key in config.yaml and writes no .env key", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir, { keyMode: "inline" }));

    const p = haimakerProvider(readYaml(dir));
    expect(p.api_key).toBe(KEY);
    expect(p.key_env).toBeUndefined();
    // The secret is in config.yaml now, so .env must not carry it.
    const env = fs.existsSync(envPath(dir)) ? readEnv(dir) : "";
    expect(env).not.toContain(`HAIMAKER_API_KEY=${KEY}`);
  });

  it("env mode keeps the key in .env via key_env (not in config.yaml)", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir, { keyMode: "env" }));

    const p = haimakerProvider(readYaml(dir));
    expect(p.key_env).toBe("HAIMAKER_API_KEY");
    expect(p.api_key).toBeUndefined();
    expect(readEnv(dir)).toContain(`HAIMAKER_API_KEY=${KEY}`);
    expect(fs.readFileSync(yamlPath(dir), "utf8")).not.toContain(KEY);
  });

  it("rejects (and does not overwrite) a malformed config.yaml", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".hermes"));
    const broken = "model: { provider: openai"; // unterminated flow map
    fs.writeFileSync(yamlPath(dir), broken);

    await expect(hermesWriter.configure(ctx(dir))).rejects.toThrow(/could not be parsed/i);
    expect(fs.readFileSync(yamlPath(dir), "utf8")).toBe(broken);
  });
});

describe("hermesWriter.uninstall", () => {
  it("removes our provider + selection and our env key, leaving the rest", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".hermes"));
    fs.writeFileSync(
      yamlPath(dir),
      "custom_providers:\n  - name: local\n    base_url: http://localhost:8080/v1\ntheme: dark\n"
    );
    fs.writeFileSync(envPath(dir), "OPENAI_API_KEY=sk-existing\n");

    await hermesWriter.configure(ctx(dir));
    await hermesWriter.uninstall({ kind: "user", dir });

    const cfg = readYaml(dir);
    expect(haimakerProvider(cfg)).toBeUndefined();
    expect(cfg.custom_providers.map((p: any) => p.name)).toEqual(["local"]);
    // We created model{} and fully owned it -> removed on uninstall.
    expect(cfg.model).toBeUndefined();
    expect(cfg.theme).toBe("dark");

    const env = readEnv(dir);
    expect(env).toContain("OPENAI_API_KEY=sk-existing");
    expect(env).not.toContain("HAIMAKER_API_KEY");
  });

  it("removes a concrete-model selection we wrote (no leftover)", async () => {
    const dir = tmp();
    await hermesWriter.configure(ctx(dir, { model: "openai/gpt-4o" }));
    await hermesWriter.uninstall({ kind: "user", dir });

    const cfg = readYaml(dir) ?? {};
    expect(cfg.custom_providers).toBeUndefined();
    expect(cfg.model).toBeUndefined();
  });

  it("does NOT reset a user-chosen active provider", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".hermes"));
    fs.writeFileSync(yamlPath(dir), "model:\n  provider: openai\n");

    await hermesWriter.configure(ctx(dir));
    await hermesWriter.uninstall({ kind: "user", dir });

    const cfg = readYaml(dir);
    expect(haimakerProvider(cfg)).toBeUndefined();
    expect(cfg.model.provider).toBe("openai");
  });

  it("is a no-op when nothing was written", async () => {
    const dir = tmp();
    await hermesWriter.uninstall({ kind: "user", dir });
    expect(fs.existsSync(yamlPath(dir))).toBe(false);
    expect(fs.existsSync(envPath(dir))).toBe(false);
  });
});

describe("hermesWriter.verify (chat surface, mocked fetch)", () => {
  it("posts to /v1/chat/completions with a Bearer token", async () => {
    const dir = tmp();
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string, init: any) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
      }) as unknown as typeof fetch
    );

    const res = await hermesWriter.verify(ctx(dir));
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.haimaker.ai/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});
