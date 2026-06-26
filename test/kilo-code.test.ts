import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { makeTmpDir, cleanup } from "./helpers";
import { kiloCodeWriter } from "../src/agents/kilo-code";
import { Scope, InstallCtx } from "../src/agents/types";
import { DEFAULT_HOST, DEFAULT_MODEL } from "../src/endpoint";
import type { FetchLike } from "../src/models";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-kilo");
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function userScope(dir: string): Scope {
  return { kind: "user", dir };
}

function ctxFor(scope: Scope, over: Partial<InstallCtx> = {}): InstallCtx {
  return {
    scope,
    host: DEFAULT_HOST,
    apiKey: "sk-haimaker-secret-123",
    model: DEFAULT_MODEL,
    verify: false,
    ...over,
  };
}

function readConfig(dir: string): any {
  return JSON.parse(fs.readFileSync(configPath(dir), "utf8"));
}

function configPath(dir: string): string {
  return path.join(dir, ".config", "kilo", "kilo.jsonc");
}

/** Create the kilo config dir (XDG: {dir}/.config/kilo). */
function mkKiloDir(dir: string): void {
  fs.mkdirSync(path.join(dir, ".config", "kilo"), { recursive: true });
}

describe("kiloCodeWriter metadata", () => {
  it("has the expected identity and surface", () => {
    expect(kiloCodeWriter.id).toBe("kilo-code");
    expect(kiloCodeWriter.surface).toBe("chat");
  });

  it("resolves configPath under scope.dir", () => {
    const dir = tmp();
    expect(kiloCodeWriter.configPath(userScope(dir))).toBe(
      path.join(dir, ".config", "kilo", "kilo.jsonc")
    );
  });
});

describe("kiloCodeWriter.detect", () => {
  it("is false when the kilo config dir does not exist", async () => {
    const dir = tmp();
    expect(await kiloCodeWriter.detect(userScope(dir))).toBe(false);
  });

  it("is true once the kilo config dir exists", async () => {
    const dir = tmp();
    mkKiloDir(dir);
    expect(await kiloCodeWriter.detect(userScope(dir))).toBe(true);
  });
});

describe("kiloCodeWriter.configure", () => {
  it("writes the expected config on a fresh install", async () => {
    const dir = tmp();
    await kiloCodeWriter.configure(ctxFor(userScope(dir)));

    const cfg = readConfig(dir);
    expect(cfg.$schema).toBe("https://app.kilo.ai/config.json");
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(cfg.provider.haimaker).toEqual({
      api: "openai-compatible",
      options: {
        apiKey: "sk-haimaker-secret-123",
        // chat surface -> host + "/v1"
        baseURL: "https://api.haimaker.ai/v1",
      },
      models: {
        auto: { name: "Haimaker Auto", tool_call: true },
      },
    });
  });

  it("normalizes a host that already ends in /v1 (no /v1/v1)", async () => {
    const dir = tmp();
    await kiloCodeWriter.configure(
      ctxFor(userScope(dir), { host: "https://api.haimaker.ai/v1" })
    );
    const cfg = readConfig(dir);
    expect(cfg.provider.haimaker.options.baseURL).toBe(
      "https://api.haimaker.ai/v1"
    );
  });

  it("writes the secret-bearing file with mode 0600", async () => {
    const dir = tmp();
    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    const st = fs.statSync(configPath(dir));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("is idempotent: re-running does not duplicate providers", async () => {
    const dir = tmp();
    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    const first = fs.readFileSync(configPath(dir), "utf8");
    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    const second = fs.readFileSync(configPath(dir), "utf8");
    expect(second).toBe(first);

    const cfg = readConfig(dir);
    expect(Object.keys(cfg.provider)).toEqual(["haimaker"]);
  });

  it("preserves a pre-existing unrelated provider and other keys", async () => {
    const dir = tmp();
    const kiloPath = configPath(dir);
    mkKiloDir(dir);
    fs.writeFileSync(
      kiloPath,
      JSON.stringify(
        {
          $schema: "https://custom.example/schema.json",
          theme: "dark",
          provider: {
            openai: { options: { apiKey: "sk-openai-xyz" } },
          },
        },
        null,
        2
      )
    );

    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    const cfg = readConfig(dir);

    // unrelated provider preserved
    expect(cfg.provider.openai).toEqual({ options: { apiKey: "sk-openai-xyz" } });
    // our provider added
    expect(cfg.provider.haimaker.options.baseURL).toBe(
      "https://api.haimaker.ai/v1"
    );
    // existing $schema NOT clobbered
    expect(cfg.$schema).toBe("https://custom.example/schema.json");
    // unrelated top-level key preserved
    expect(cfg.theme).toBe("dark");
    // model was unset -> we own it
    expect(cfg.model).toBe(DEFAULT_MODEL);
  });

  it("does not overwrite a user-chosen non-haimaker model", async () => {
    const dir = tmp();
    const kiloPath = configPath(dir);
    mkKiloDir(dir);
    fs.writeFileSync(kiloPath, JSON.stringify({ model: "openai/gpt-4o" }, null, 2));

    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    const cfg = readConfig(dir);
    expect(cfg.model).toBe("openai/gpt-4o");
  });

  it("does overwrite a previous haimaker/* model", async () => {
    const dir = tmp();
    const kiloPath = configPath(dir);
    mkKiloDir(dir);
    fs.writeFileSync(
      kiloPath,
      JSON.stringify({ model: "haimaker/old" }, null, 2)
    );

    await kiloCodeWriter.configure(
      ctxFor(userScope(dir), { model: "haimaker/auto" })
    );
    const cfg = readConfig(dir);
    expect(cfg.model).toBe("haimaker/auto");
  });

  it("backs up the original config on first write", async () => {
    const dir = tmp();
    const kiloPath = configPath(dir);
    mkKiloDir(dir);
    fs.writeFileSync(kiloPath, '{"theme":"light"}');

    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    expect(fs.readFileSync(`${kiloPath}.haimaker.bak`, "utf8")).toBe(
      '{"theme":"light"}'
    );
  });
});

describe("kiloCodeWriter.uninstall", () => {
  it("removes only our provider and haimaker/* model, leaving the rest", async () => {
    const dir = tmp();
    const kiloPath = configPath(dir);
    mkKiloDir(dir);
    fs.writeFileSync(
      kiloPath,
      JSON.stringify(
        {
          $schema: "https://app.kilo.ai/config.json",
          theme: "dark",
          provider: {
            openai: { options: { apiKey: "sk-openai-xyz" } },
          },
        },
        null,
        2
      )
    );

    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    await kiloCodeWriter.uninstall(userScope(dir));

    const cfg = readConfig(dir);
    expect(cfg.provider.haimaker).toBeUndefined();
    // unrelated provider survives
    expect(cfg.provider.openai).toEqual({ options: { apiKey: "sk-openai-xyz" } });
    // our haimaker/* model removed
    expect(cfg.model).toBeUndefined();
    // unrelated keys survive
    expect(cfg.theme).toBe("dark");
    expect(cfg.$schema).toBe("https://app.kilo.ai/config.json");
  });

  it("leaves a user-chosen non-haimaker model in place", async () => {
    const dir = tmp();
    const kiloPath = configPath(dir);
    mkKiloDir(dir);
    fs.writeFileSync(kiloPath, JSON.stringify({ model: "openai/gpt-4o" }, null, 2));

    await kiloCodeWriter.configure(ctxFor(userScope(dir)));
    await kiloCodeWriter.uninstall(userScope(dir));

    const cfg = readConfig(dir);
    expect(cfg.model).toBe("openai/gpt-4o");
    expect(cfg.provider).toBeUndefined();
  });

  it("is a no-op when no config file exists", async () => {
    const dir = tmp();
    await kiloCodeWriter.uninstall(userScope(dir));
    expect(fs.existsSync(configPath(dir))).toBe(false);
  });
});

describe("kiloCodeWriter.verify", () => {
  it("uses the chat surface base URL and a mocked fetch (no live calls)", async () => {
    let calledUrl = "";
    const fakeFetch: FetchLike = async (input: any) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // verifySurface is injectable via the shared verify module; here we
    // exercise the surface-correct URL by calling verifySurface directly with
    // the same baseUrl kiloCodeWriter.verify would derive.
    const { verifySurface } = await import("../src/verify");
    const { baseUrlForSurface } = await import("../src/endpoint");
    const baseUrl = baseUrlForSurface(DEFAULT_HOST, "chat");
    const res = await verifySurface({
      surface: "chat",
      baseUrl,
      apiKey: "sk-test",
      model: DEFAULT_MODEL,
      fetchImpl: fakeFetch,
    });

    expect(res.ok).toBe(true);
    expect(calledUrl).toBe("https://api.haimaker.ai/v1/chat/completions");
  });
});
