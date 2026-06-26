import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTmpDir, cleanup } from "./helpers";
import { claudeCodeWriter } from "../src/agents/claude-code";
import { InstallCtx, Scope } from "../src/agents/types";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-claude");
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) cleanup(dirs.pop()!);
});

function ctx(dir: string, over: Partial<InstallCtx> = {}): InstallCtx {
  const scope: Scope = { kind: "user", dir };
  return {
    scope,
    host: "https://api.haimaker.ai",
    apiKey: "sk-secret-123",
    model: "haimaker/auto",
    verify: false,
    ...over,
  };
}

function settingsPath(dir: string): string {
  return path.join(dir, ".claude", "settings.json");
}

function readSettings(dir: string): any {
  return JSON.parse(fs.readFileSync(settingsPath(dir), "utf8"));
}

describe("claudeCodeWriter metadata", () => {
  it("has the expected identity and surface", () => {
    expect(claudeCodeWriter.id).toBe("claude-code");
    expect(claudeCodeWriter.surface).toBe("messages");
  });

  it("resolves configPath under scope.dir", () => {
    const dir = tmp();
    expect(claudeCodeWriter.configPath({ kind: "user", dir })).toBe(settingsPath(dir));
  });
});

describe("claudeCodeWriter.detect", () => {
  it("is false when ~/.claude does not exist", async () => {
    const dir = tmp();
    expect(await claudeCodeWriter.detect({ kind: "user", dir })).toBe(false);
  });

  it("is true when the .claude directory exists", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".claude"));
    expect(await claudeCodeWriter.detect({ kind: "user", dir })).toBe(true);
  });
});

describe("claudeCodeWriter.configure", () => {
  it("fresh install writes the four env keys with the bare-host base URL", async () => {
    const dir = tmp();
    await claudeCodeWriter.configure(ctx(dir));
    const s = readSettings(dir);
    expect(s.env.ANTHROPIC_BASE_URL).toBe("https://api.haimaker.ai"); // messages -> NO /v1
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-secret-123");
    expect(s.env.ANTHROPIC_MODEL).toBe("haimaker/auto");
    expect(s.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("haimaker/auto");
  });

  it("normalizes a host that already carries a trailing /v1 (no /v1 for messages)", async () => {
    const dir = tmp();
    await claudeCodeWriter.configure(ctx(dir, { host: "https://api.haimaker.ai/v1/" }));
    const s = readSettings(dir);
    expect(s.env.ANTHROPIC_BASE_URL).toBe("https://api.haimaker.ai");
  });

  it("writes the secret-bearing file with mode 0600", async () => {
    const dir = tmp();
    await claudeCodeWriter.configure(ctx(dir));
    const st = fs.statSync(settingsPath(dir));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("is idempotent: a second run does not duplicate or change anything", async () => {
    const dir = tmp();
    await claudeCodeWriter.configure(ctx(dir));
    const first = fs.readFileSync(settingsPath(dir), "utf8");
    await claudeCodeWriter.configure(ctx(dir));
    const second = fs.readFileSync(settingsPath(dir), "utf8");
    expect(second).toBe(first);
    const s = JSON.parse(second);
    expect(Object.keys(s.env)).toHaveLength(4);
  });

  it("preserves unrelated top-level keys and unrelated env vars", async () => {
    const dir = tmp();
    const p = settingsPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        $schema: "https://example.com/schema.json",
        permissions: { allow: ["Bash"] },
        env: { MY_EXISTING: "keep-me", ANTHROPIC_MODEL: "stale" },
      }),
    );

    await claudeCodeWriter.configure(ctx(dir));
    const s = readSettings(dir);

    // unrelated keys untouched
    expect(s.$schema).toBe("https://example.com/schema.json");
    expect(s.permissions.allow).toEqual(["Bash"]);
    // unrelated env var preserved, our keys merged/overwritten
    expect(s.env.MY_EXISTING).toBe("keep-me");
    expect(s.env.ANTHROPIC_MODEL).toBe("haimaker/auto");
    expect(s.env.ANTHROPIC_BASE_URL).toBe("https://api.haimaker.ai");
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-secret-123");
  });

  it("creates a .haimaker.bak preserving the original on first write", async () => {
    const dir = tmp();
    const p = settingsPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original = JSON.stringify({ env: { MY_EXISTING: "keep-me" } });
    fs.writeFileSync(p, original);

    await claudeCodeWriter.configure(ctx(dir));
    expect(fs.readFileSync(`${p}.haimaker.bak`, "utf8")).toBe(original);

    // second run must not overwrite the original backup
    await claudeCodeWriter.configure(ctx(dir, { model: "anthropic/claude" }));
    expect(fs.readFileSync(`${p}.haimaker.bak`, "utf8")).toBe(original);
  });
});

describe("claudeCodeWriter.uninstall", () => {
  it("removes exactly our four keys and drops the empty env object", async () => {
    const dir = tmp();
    await claudeCodeWriter.configure(ctx(dir));
    await claudeCodeWriter.uninstall({ kind: "user", dir });
    const s = readSettings(dir);
    expect(s.env).toBeUndefined();
  });

  it("removes our keys but preserves other env vars and top-level keys", async () => {
    const dir = tmp();
    const p = settingsPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ telemetry: false, env: { MY_EXISTING: "keep-me" } }),
    );

    await claudeCodeWriter.configure(ctx(dir));
    await claudeCodeWriter.uninstall({ kind: "user", dir });

    const s = readSettings(dir);
    expect(s.telemetry).toBe(false);
    expect(s.env).toEqual({ MY_EXISTING: "keep-me" });
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("is a no-op when the settings file does not exist", async () => {
    const dir = tmp();
    await claudeCodeWriter.uninstall({ kind: "user", dir });
    expect(fs.existsSync(settingsPath(dir))).toBe(false);
  });

  it("uninstalled file retains mode 0600", async () => {
    const dir = tmp();
    await claudeCodeWriter.configure(ctx(dir));
    await claudeCodeWriter.uninstall({ kind: "user", dir });
    const st = fs.statSync(settingsPath(dir));
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("claudeCodeWriter.verify", () => {
  it("hits the messages surface and returns ok on 200 (mocked fetch, no live calls)", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mock = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", mock);

    const res = await claudeCodeWriter.verify(ctx(tmp(), { verify: true }));
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    // messages surface: bare host root + SDK path
    expect(calls[0].url).toBe("https://api.haimaker.ai/v1/messages");
    expect(calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-secret-123");
  });

  it("surfaces autoRouterHint on a 400 (mocked fetch)", async () => {
    const mock = vi.fn(async () => {
      return { ok: false, status: 400, json: async () => ({ error: "bad" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", mock);

    const res = await claudeCodeWriter.verify(ctx(tmp(), { verify: true }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.autoRouterHint).toBe(true);
    expect(res.message).toContain("app.haimaker.ai/api-keys");
  });
});
