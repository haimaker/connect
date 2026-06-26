import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTmpDir, cleanup } from "./helpers";
import { opencodeWriter } from "../src/agents/opencode";
import { InstallCtx, Scope } from "../src/agents/types";

const HOST = "https://api.haimaker.ai";
const KEY = "sk-secret-do-not-leak";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-opencode");
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function userCtx(dir: string, overrides: Partial<InstallCtx> = {}): InstallCtx {
  return {
    scope: { kind: "user", dir },
    host: HOST,
    apiKey: KEY,
    model: "haimaker/auto",
    verify: false,
    ...overrides,
  };
}

function projectCtx(cwd: string, overrides: Partial<InstallCtx> = {}): InstallCtx {
  return {
    scope: { kind: "project", cwd },
    host: HOST,
    apiKey: KEY,
    model: "haimaker/auto",
    verify: false,
    ...overrides,
  };
}

function readConfig(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("opencodeWriter - identity", () => {
  it("has the expected id/surface", () => {
    expect(opencodeWriter.id).toBe("opencode");
    expect(opencodeWriter.surface).toBe("chat");
  });
});

describe("opencodeWriter - configPath", () => {
  it("user scope resolves under {dir}/.config/opencode/opencode.json", () => {
    const dir = tmp();
    expect(opencodeWriter.configPath({ kind: "user", dir })).toBe(
      path.join(dir, ".config", "opencode", "opencode.json")
    );
  });

  it("project scope resolves under {cwd}/opencode.json", () => {
    const cwd = tmp();
    expect(opencodeWriter.configPath({ kind: "project", cwd })).toBe(
      path.join(cwd, "opencode.json")
    );
  });
});

describe("opencodeWriter - configure (user scope)", () => {
  it("fresh install writes the expected provider + model", async () => {
    const dir = tmp();
    await opencodeWriter.configure(userCtx(dir));

    const p = opencodeWriter.configPath({ kind: "user", dir });
    const cfg = readConfig(p);

    expect(cfg.provider.haimaker).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Haimaker",
      options: {
        baseURL: "https://api.haimaker.ai/v1",
        apiKey: KEY,
      },
      models: { auto: { name: "Haimaker Auto" } },
    });
    expect(cfg.model).toBe("haimaker/auto");
  });

  it("uses the chat-surface base URL (host + /v1, never /v1/v1)", async () => {
    const dir = tmp();
    // Pass an un-normalized host with a trailing /v1 to confirm normalization.
    await opencodeWriter.configure(userCtx(dir, { host: "https://api.haimaker.ai/v1/" }));
    const cfg = readConfig(opencodeWriter.configPath({ kind: "user", dir }));
    expect(cfg.provider.haimaker.options.baseURL).toBe("https://api.haimaker.ai/v1");
  });

  it("writes the secret-bearing file with mode 0600", async () => {
    const dir = tmp();
    await opencodeWriter.configure(userCtx(dir));
    const p = opencodeWriter.configPath({ kind: "user", dir });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: re-running does not duplicate or change anything", async () => {
    const dir = tmp();
    await opencodeWriter.configure(userCtx(dir));
    const p = opencodeWriter.configPath({ kind: "user", dir });
    const first = fs.readFileSync(p, "utf8");

    await opencodeWriter.configure(userCtx(dir));
    const second = fs.readFileSync(p, "utf8");

    expect(second).toBe(first);
    // exactly one provider entry
    const cfg = JSON.parse(second);
    expect(Object.keys(cfg.provider)).toEqual(["haimaker"]);
  });

  it("preserves unrelated providers and top-level keys", async () => {
    const dir = tmp();
    const p = opencodeWriter.configPath({ kind: "user", dir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "tokyonight",
        provider: {
          openai: { options: { apiKey: "sk-openai-untouched" } },
        },
      })
    );

    await opencodeWriter.configure(userCtx(dir));
    const cfg = readConfig(p);

    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    expect(cfg.theme).toBe("tokyonight");
    expect(cfg.provider.openai).toEqual({ options: { apiKey: "sk-openai-untouched" } });
    expect(cfg.provider.haimaker.npm).toBe("@ai-sdk/openai-compatible");
    expect(cfg.model).toBe("haimaker/auto");
  });

  it("does not overwrite a non-haimaker top-level model", async () => {
    const dir = tmp();
    const p = opencodeWriter.configPath({ kind: "user", dir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ model: "openai/gpt-4o" }));

    await opencodeWriter.configure(userCtx(dir));
    const cfg = readConfig(p);

    expect(cfg.model).toBe("openai/gpt-4o");
    expect(cfg.provider.haimaker).toBeTruthy();
  });

  it("overwrites a stale haimaker/* top-level model with the new value", async () => {
    const dir = tmp();
    const p = opencodeWriter.configPath({ kind: "user", dir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ model: "haimaker/old" }));

    await opencodeWriter.configure(userCtx(dir, { model: "haimaker/auto" }));
    expect(readConfig(p).model).toBe("haimaker/auto");
  });

  it("a concrete --model is exposed by the provider and kept in the haimaker/ namespace", async () => {
    const dir = tmp();
    await opencodeWriter.configure(userCtx(dir, { model: "openai/gpt-4o" }));
    const cfg = readConfig(opencodeWriter.configPath({ kind: "user", dir }));

    // Provider exposes exactly the selected model (so the agent can resolve it)...
    expect(cfg.provider.haimaker.models).toEqual({
      "openai/gpt-4o": { name: "Haimaker openai/gpt-4o" },
    });
    // ...and the default reference stays namespaced so uninstall recognizes it.
    expect(cfg.model).toBe("haimaker/openai/gpt-4o");
  });

  it("uninstall removes a concrete-model default we wrote (no leftover)", async () => {
    const dir = tmp();
    await opencodeWriter.configure(userCtx(dir, { model: "openai/gpt-4o" }));
    await opencodeWriter.uninstall({ kind: "user", dir });
    const cfg = readConfig(opencodeWriter.configPath({ kind: "user", dir }));
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBeUndefined();
  });
});

describe("opencodeWriter - configure (project scope)", () => {
  it("writes {cwd}/opencode.json and gitignores it", async () => {
    const cwd = tmp();
    await opencodeWriter.configure(projectCtx(cwd));

    const p = path.join(cwd, "opencode.json");
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);

    const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    const occurrences = gitignore
      .split("\n")
      .filter((l) => l.trim() === "opencode.json").length;
    expect(occurrences).toBe(1);
  });

  it("gitignore stays a single entry on re-run", async () => {
    const cwd = tmp();
    await opencodeWriter.configure(projectCtx(cwd));
    await opencodeWriter.configure(projectCtx(cwd));
    const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    const occurrences = gitignore
      .split("\n")
      .filter((l) => l.trim() === "opencode.json").length;
    expect(occurrences).toBe(1);
  });

  it("refuses to write into a git-tracked opencode.json (would commit the secret)", async () => {
    const cwd = tmp();
    execFileSync("git", ["init", "-q"], { cwd });
    fs.writeFileSync(path.join(cwd, "opencode.json"), "{}");
    execFileSync("git", ["add", "opencode.json"], { cwd });

    await expect(opencodeWriter.configure(projectCtx(cwd))).rejects.toThrow(/tracked by git/i);
    // The tracked file was NOT overwritten with a secret.
    expect(fs.readFileSync(path.join(cwd, "opencode.json"), "utf8")).toBe("{}");
  });
});

describe("opencodeWriter - uninstall", () => {
  it("removes exactly the haimaker provider and our model, leaving the rest", async () => {
    const dir = tmp();
    const p = opencodeWriter.configPath({ kind: "user", dir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        theme: "tokyonight",
        provider: { openai: { options: { apiKey: "sk-openai" } } },
      })
    );

    await opencodeWriter.configure(userCtx(dir));
    await opencodeWriter.uninstall({ kind: "user", dir });

    const cfg = readConfig(p);
    expect(cfg.provider.haimaker).toBeUndefined();
    expect(cfg.provider.openai).toEqual({ options: { apiKey: "sk-openai" } });
    expect(cfg.model).toBeUndefined();
    expect(cfg.theme).toBe("tokyonight");
  });

  it("leaves a non-haimaker top-level model untouched", async () => {
    const dir = tmp();
    const p = opencodeWriter.configPath({ kind: "user", dir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ model: "openai/gpt-4o" }));

    await opencodeWriter.configure(userCtx(dir));
    await opencodeWriter.uninstall({ kind: "user", dir });

    const cfg = readConfig(p);
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBe("openai/gpt-4o");
  });

  it("is a no-op when the config file does not exist", async () => {
    const dir = tmp();
    await expect(opencodeWriter.uninstall({ kind: "user", dir })).resolves.toBeUndefined();
    expect(fs.existsSync(opencodeWriter.configPath({ kind: "user", dir }))).toBe(false);
  });
});

describe("opencodeWriter - detect", () => {
  it("true when the opencode config dir exists", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".config", "opencode"), { recursive: true });
    expect(await opencodeWriter.detect({ kind: "user", dir })).toBe(true);
  });

  it("false when neither the config dir nor a binary is present", async () => {
    const dir = tmp();
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(await opencodeWriter.detect({ kind: "user", dir })).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("opencodeWriter - verify (mocked fetch, no network)", () => {
  it("hits the chat-completions URL and reports ok", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const res = await opencodeWriter.verify(userCtx(tmp(), { verify: true }));
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(calls[0].url).toBe("https://api.haimaker.ai/v1/chat/completions");
      expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
