import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as TOML from "@iarna/toml";
import { makeTmpDir, cleanup } from "./helpers";
import { codexWriter, CODEX_ENV_GUIDANCE } from "../src/agents/codex";
import { Scope, InstallCtx } from "../src/agents/types";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-codex");
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (dirs.length) cleanup(dirs.pop()!);
});

// Silence + capture the env-var guidance that configure() prints.
function spyConsole() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

const API_KEY = "sk-secret-do-not-leak-123";

function ctx(dir: string, overrides: Partial<InstallCtx> = {}): InstallCtx {
  const scope: Scope = { kind: "user", dir };
  return {
    scope,
    host: "https://api.haimaker.ai",
    apiKey: API_KEY,
    model: "anthropic/claude-sonnet-4",
    verify: false,
    ...overrides,
  };
}

function readConfig(dir: string): string {
  return fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
}

describe("codexWriter metadata", () => {
  it("is the responses-surface Codex writer", () => {
    expect(codexWriter.id).toBe("codex");
    expect(codexWriter.surface).toBe("responses");
  });

  it("resolves configPath under scope.dir (never the real home)", () => {
    const dir = tmp();
    expect(codexWriter.configPath({ kind: "user", dir })).toBe(
      path.join(dir, ".codex", "config.toml")
    );
  });
});

describe("codexWriter.detect", () => {
  it("is true when ~/.codex exists, false otherwise", async () => {
    const withDir = tmp();
    fs.mkdirSync(path.join(withDir, ".codex"));
    expect(await codexWriter.detect({ kind: "user", dir: withDir })).toBe(true);

    const without = tmp();
    expect(await codexWriter.detect({ kind: "user", dir: without })).toBe(false);
  });
});

describe("codexWriter.configure - fresh install", () => {
  it("writes the expected managed TOML block", async () => {
    const dir = tmp();
    const spy = spyConsole();
    await codexWriter.configure(ctx(dir));

    const content = readConfig(dir);
    expect(content).toContain("# >>> haimaker managed (do not edit between markers) >>>");
    expect(content).toContain("# <<< haimaker managed <<<");

    const parsed: any = TOML.parse(content);
    expect(parsed.model_provider).toBe("haimaker");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4");
    const p = parsed.model_providers.haimaker;
    expect(p.name).toBe("Haimaker");
    expect(p.base_url).toBe("https://api.haimaker.ai/v1");
    expect(p.env_key).toBe("HAIMAKER_API_KEY");
    expect(p.wire_api).toBe("responses");

    // The config file must NEVER contain the secret key.
    expect(content).not.toContain(API_KEY);

    // Guidance was surfaced, mentions the env var, and never leaks the key.
    expect(spy).toHaveBeenCalled();
    const printed = spy.mock.calls.flat().join(" ");
    expect(printed).toContain("HAIMAKER_API_KEY");
    expect(printed).not.toContain(API_KEY);
    expect(CODEX_ENV_GUIDANCE).not.toContain(API_KEY);
  });

  it("writes the config file with mode 0o600", async () => {
    const dir = tmp();
    spyConsole();
    await codexWriter.configure(ctx(dir));
    const st = fs.statSync(path.join(dir, ".codex", "config.toml"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("prints export guidance in env mode, stays quiet in profile mode", async () => {
    const dir = tmp();
    const spy = spyConsole();
    await codexWriter.configure(ctx(dir)); // default keyMode -> env
    expect(spy.mock.calls.flat().join(" ")).toContain("export HAIMAKER_API_KEY");

    spy.mockClear();
    await codexWriter.configure(ctx(dir, { keyMode: "profile" }));
    // In profile mode the CLI writes the export and prints that; the writer is quiet.
    expect(spy.mock.calls.flat().join(" ")).not.toContain("export HAIMAKER_API_KEY");
  });

  it("normalizes a messy host to the responses base_url (host + /v1)", async () => {
    const dir = tmp();
    spyConsole();
    await codexWriter.configure(ctx(dir, { host: "https://api.haimaker.ai/v1/" }));
    const parsed: any = TOML.parse(readConfig(dir));
    expect(parsed.model_providers.haimaker.base_url).toBe("https://api.haimaker.ai/v1");
  });
});

describe("codexWriter.configure - idempotency & preservation", () => {
  it("re-running does not duplicate the managed block and updates values", async () => {
    const dir = tmp();
    spyConsole();
    await codexWriter.configure(ctx(dir));
    await codexWriter.configure(ctx(dir, { model: "openai/gpt-5" }));

    const content = readConfig(dir);
    const beginCount =
      content.split("# >>> haimaker managed (do not edit between markers) >>>").length - 1;
    expect(beginCount).toBe(1);

    const parsed: any = TOML.parse(content);
    expect(parsed.model).toBe("openai/gpt-5");
  });

  it("takes over an existing top-level model/model_provider without producing duplicate keys", async () => {
    const dir = tmp();
    const cfgPath = path.join(dir, ".codex", "config.toml");
    fs.mkdirSync(path.join(dir, ".codex"));
    // A real config that already selects a model + provider at the top level.
    fs.writeFileSync(
      cfgPath,
      'model = "openai/gpt-5"\nmodel_provider = "openai"\napproval_policy = "on-failure"\n'
    );

    spyConsole();
    await codexWriter.configure(ctx(dir, { model: "openai/gpt-4o" }));

    // The result MUST parse (duplicate top-level keys would throw here)...
    const parsed: any = TOML.parse(readConfig(dir));
    expect(parsed.model).toBe("openai/gpt-4o");
    expect(parsed.model_provider).toBe("haimaker");
    // ...unrelated keys preserved.
    expect(parsed.approval_policy).toBe("on-failure");
    // ...and there is exactly one top-level `model =` line.
    const modelLines = readConfig(dir)
      .split("\n")
      .filter((l) => /^model = /.test(l));
    expect(modelLines).toHaveLength(1);
  });

  it("preserves unrelated top-level keys and other providers/sections", async () => {
    const dir = tmp();
    const cfgPath = path.join(dir, ".codex", "config.toml");
    fs.mkdirSync(path.join(dir, ".codex"));
    const original =
      'approval_policy = "on-failure"\n' +
      "\n" +
      "[model_providers.openai]\n" +
      'name = "OpenAI"\n' +
      'base_url = "https://api.openai.com/v1"\n';
    fs.writeFileSync(cfgPath, original);

    spyConsole();
    await codexWriter.configure(ctx(dir));

    const parsed: any = TOML.parse(readConfig(dir));
    // ours
    expect(parsed.model_provider).toBe("haimaker");
    expect(parsed.model_providers.haimaker.base_url).toBe("https://api.haimaker.ai/v1");
    // theirs preserved
    expect(parsed.approval_policy).toBe("on-failure");
    expect(parsed.model_providers.openai.name).toBe("OpenAI");
    expect(parsed.model_providers.openai.base_url).toBe("https://api.openai.com/v1");
  });
});

describe("codexWriter.uninstall", () => {
  it("removes exactly our block, restoring the original byte-for-byte", async () => {
    const dir = tmp();
    const cfgPath = path.join(dir, ".codex", "config.toml");
    fs.mkdirSync(path.join(dir, ".codex"));
    const original =
      'approval_policy = "on-failure"\n' +
      "\n" +
      "[model_providers.openai]\n" +
      'name = "OpenAI"\n' +
      'base_url = "https://api.openai.com/v1"\n';
    fs.writeFileSync(cfgPath, original);

    spyConsole();
    await codexWriter.configure(ctx(dir));
    await codexWriter.uninstall({ kind: "user", dir });

    expect(readConfig(dir)).toBe(original);
  });

  it("from a fresh install, uninstall leaves only whitespace", async () => {
    const dir = tmp();
    spyConsole();
    await codexWriter.configure(ctx(dir));
    await codexWriter.uninstall({ kind: "user", dir });
    expect(readConfig(dir).trim()).toBe("");
  });

  it("restores the user's original top-level model/model_provider it took over", async () => {
    const dir = tmp();
    const cfgPath = path.join(dir, ".codex", "config.toml");
    fs.mkdirSync(path.join(dir, ".codex"));
    const original = 'model = "openai/gpt-5"\nmodel_provider = "openai"\napproval = "ask"\n';
    fs.writeFileSync(cfgPath, original);

    spyConsole();
    await codexWriter.configure(ctx(dir, { model: "openai/gpt-4o" }));
    // While configured, our values are active.
    const active: any = TOML.parse(readConfig(dir));
    expect(active.model).toBe("openai/gpt-4o");
    expect(active.model_provider).toBe("haimaker");

    // Uninstall restores the user's original selection byte-for-byte.
    await codexWriter.uninstall({ kind: "user", dir });
    expect(readConfig(dir)).toBe(original);
  });

  it("preserves the ORIGINAL values across a re-configure, then restores them", async () => {
    const dir = tmp();
    const cfgPath = path.join(dir, ".codex", "config.toml");
    fs.mkdirSync(path.join(dir, ".codex"));
    fs.writeFileSync(cfgPath, 'model = "openai/gpt-5"\nmodel_provider = "openai"\n');

    spyConsole();
    await codexWriter.configure(ctx(dir, { model: "openai/gpt-4o" }));
    await codexWriter.configure(ctx(dir, { model: "deepseek/deepseek-v3" })); // re-run
    await codexWriter.uninstall({ kind: "user", dir });

    const parsed: any = TOML.parse(readConfig(dir));
    expect(parsed.model).toBe("openai/gpt-5"); // the original, not the intermediate
    expect(parsed.model_provider).toBe("openai");
  });

  it("is a no-op when no config file exists", async () => {
    const dir = tmp();
    await codexWriter.uninstall({ kind: "user", dir });
    expect(fs.existsSync(path.join(dir, ".codex", "config.toml"))).toBe(false);
  });
});

describe("codexWriter.verify", () => {
  const okMock = (calls: Array<{ url: string; init: any }>) =>
    (async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "resp_1", object: "response" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

  it("reports ok when the API works AND HAIMAKER_API_KEY is present in the env", async () => {
    const dir = tmp();
    const prev = process.env.HAIMAKER_API_KEY;
    process.env.HAIMAKER_API_KEY = API_KEY;
    try {
      const calls: Array<{ url: string; init: any }> = [];
      vi.stubGlobal("fetch", okMock(calls));

      const res = await codexWriter.verify(ctx(dir));
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.haimaker.ai/v1/responses");
      expect(calls[0].init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    } finally {
      if (prev === undefined) delete process.env.HAIMAKER_API_KEY;
      else process.env.HAIMAKER_API_KEY = prev;
    }
  });

  it("reports NOT ok when HAIMAKER_API_KEY is absent, even on a 200 (Codex would fail at runtime)", async () => {
    const dir = tmp();
    const prev = process.env.HAIMAKER_API_KEY;
    delete process.env.HAIMAKER_API_KEY;
    try {
      const calls: Array<{ url: string; init: any }> = [];
      vi.stubGlobal("fetch", okMock(calls));

      const res = await codexWriter.verify(ctx(dir));
      expect(res.ok).toBe(false);
      expect(res.message).toContain("HAIMAKER_API_KEY");
    } finally {
      if (prev !== undefined) process.env.HAIMAKER_API_KEY = prev;
    }
  });

  it("surfaces autoRouterHint on a 400 (responses + auto-router is broken)", async () => {
    const dir = tmp();
    const mock = (async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ error: "bad" }),
      } as unknown as Response)) as unknown as typeof fetch;
    vi.stubGlobal("fetch", mock);

    const res = await codexWriter.verify(ctx(dir, { model: "haimaker/auto" }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.autoRouterHint).toBe(true);
  });
});
