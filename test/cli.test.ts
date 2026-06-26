import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTmpDir, cleanup } from "./helpers";
import { run } from "../src/cli";

const KEY = "sk-secret-do-not-leak";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-cli");
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) cleanup(dirs.pop()!);
});

/** Capture console.error output produced during fn(). */
function captureErr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("cli run() — dispatch", () => {
  it("--claude writes settings.json under the --dir home and never prints the key", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--claude", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();

    expect(code).toBe(0);
    const file = path.join(dir, ".claude", "settings.json");
    expect(fs.existsSync(file)).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cfg.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe("https://api.haimaker.ai");
    expect(cfg.env.ANTHROPIC_MODEL).toBe("haimaker/auto");

    // The key must never appear in any logged line.
    expect(cap.lines.join("\n")).not.toContain(KEY);
  });

  it("--opencode --project writes opencode.json in the repo and gitignores it", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--opencode", "--project", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();

    expect(code).toBe(0);
    const file = path.join(dir, "opencode.json");
    expect(fs.existsSync(file)).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cfg.provider.haimaker.options.apiKey).toBe(KEY);

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/).map((l) => l.trim())).toContain("opencode.json");

    expect(cap.lines.join("\n")).not.toContain(KEY);
  });

  it("--uninstall --claude removes our managed env keys", async () => {
    const dir = tmp();
    const cap1 = captureErr();
    await run(["--claude", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap1.restore();

    const cap2 = captureErr();
    const code = await run(["--uninstall", "--claude", "--dir", dir]);
    cap2.restore();

    expect(code).toBe(0);
    const file = path.join(dir, ".claude", "settings.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    // Our four env keys (and the now-empty env object) are gone.
    expect(cfg.env).toBeUndefined();
  });

  it("--hermes writes config.yaml + .env (config-only, no Python) and keeps the key out of logs", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--hermes", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();

    expect(code).toBe(0);
    const yamlPath = path.join(dir, ".hermes", "config.yaml");
    const envPath = path.join(dir, ".hermes", ".env");
    expect(fs.existsSync(yamlPath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);

    // Secret only in .env, never in config.yaml or the logs.
    expect(fs.readFileSync(yamlPath, "utf8")).not.toContain(KEY);
    expect(fs.readFileSync(envPath, "utf8")).toContain(KEY);
    expect(cap.lines.join("\n")).not.toContain(KEY);
  });

  it("--codex configures on the default model (no longer gated)", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--codex", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.lines.join("\n").toLowerCase()).not.toContain("gated");
    const toml = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('model = "haimaker/auto"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("--help prints usage and returns 0", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await run(["--help"]);
    spy.mockRestore();
    expect(code).toBe(0);
  });

  it("rejects unknown flags with a non-zero code", async () => {
    const cap = captureErr();
    const code = await run(["--definitely-not-a-flag"]);
    cap.restore();
    expect(code).toBe(1);
  });
});

describe("cli run() — guardrails", () => {
  it("rejects a valued flag with a missing value", async () => {
    const cap = captureErr();
    const code = await run(["--claude", "--dir"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toMatch(/requires a value/i);
  });

  it("does not let a valued flag swallow the next flag", async () => {
    const cap = captureErr();
    // --dir has no value; --claude must not be consumed as that value.
    const code = await run(["--dir", "--claude"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toMatch(/requires a value/i);
  });

  it("rejects --project for a user-only writer (claude) before writing anything", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--claude", "--project", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.lines.join("\n").toLowerCase()).toContain("project");
    // Nothing was written.
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
  });

  it("rejects an http:// host by default (key would go in cleartext)", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run([
      "--claude", "--dir", dir, "--host", "http://api.example.com",
      "--api-key", KEY, "--no-verify",
    ]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.lines.join("\n").toLowerCase()).toMatch(/cleartext|insecure/);
  });

  it("permits an http:// host with --allow-insecure-host", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run([
      "--claude", "--dir", dir, "--host", "http://localhost:9999",
      "--allow-insecure-host", "--api-key", KEY, "--no-verify",
    ]);
    cap.restore();
    expect(code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe("http://localhost:9999");
  });

  it("--kilo configures Kilo Code (stable) at the XDG path", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--kilo", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, ".config", "kilo", "kilo.jsonc"))).toBe(true);
    expect(cap.lines.join("\n")).not.toContain(KEY);
  });

  it("--cline writes the Cline CLI providers.json and keeps the key out of logs", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--cline", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();
    expect(code).toBe(0);
    const p = path.join(dir, ".cline", "data", "settings", "providers.json");
    expect(fs.existsSync(p)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(cfg.providers["openai-compatible"].settings.baseUrl).toBe("https://api.haimaker.ai/v1");
    expect(cfg.providers["openai-compatible"].settings.apiKey).toBe(KEY);
    expect(cfg.lastUsedProvider).toBe("openai-compatible");
    expect(cap.lines.join("\n")).not.toContain(KEY);
  });

  it("rejects --uninstall --project for a user-only writer (no global mutation)", async () => {
    const dir = tmp();
    // Pre-seed a real global-style claude config under the dir.
    const seed = captureErr();
    await run(["--claude", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    seed.restore();
    const before = fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8");

    const cap = captureErr();
    const code = await run(["--uninstall", "--project", "--claude", "--dir", dir]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.lines.join("\n").toLowerCase()).toContain("project");
    // The global config is untouched.
    expect(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).toBe(before);
  });
});

describe("cli run() — key modes", () => {
  let savedShell: string | undefined;
  beforeEach(() => {
    savedShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh"; // deterministic profile path -> .zshrc
  });
  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  });

  it("rejects an invalid --key-mode", async () => {
    const cap = captureErr();
    const code = await run(["--codex", "--dir", tmp(), "--api-key", KEY, "--key-mode", "wat", "--no-verify"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toMatch(/key-mode must be one of/i);
  });

  it("--key-mode profile writes the export to the shell startup file (key not logged)", async () => {
    const dir = tmp();
    const cap = captureErr();
    const code = await run(["--codex", "--dir", dir, "--api-key", KEY, "--key-mode", "profile", "--no-verify"]);
    cap.restore();

    expect(code).toBe(0);
    const zshrc = path.join(dir, ".zshrc");
    expect(fs.existsSync(zshrc)).toBe(true);
    const body = fs.readFileSync(zshrc, "utf8");
    expect(body).toContain(`export HAIMAKER_API_KEY="${KEY}"`);
    expect(fs.statSync(zshrc).mode & 0o777).toBe(0o600);
    // Codex config still written; the key never appears in logs.
    expect(fs.existsSync(path.join(dir, ".codex", "config.toml"))).toBe(true);
    expect(cap.lines.join("\n")).not.toContain(KEY);
  });

  it("default (env) mode does NOT touch the shell startup file", async () => {
    const dir = tmp();
    const cap = captureErr();
    await run(["--codex", "--dir", dir, "--api-key", KEY, "--no-verify"]);
    cap.restore();
    expect(fs.existsSync(path.join(dir, ".zshrc"))).toBe(false);
  });

  it("--uninstall removes the shell export it wrote", async () => {
    const dir = tmp();
    let cap = captureErr();
    await run(["--codex", "--dir", dir, "--api-key", KEY, "--key-mode", "profile", "--no-verify"]);
    cap.restore();
    expect(fs.readFileSync(path.join(dir, ".zshrc"), "utf8")).toContain("HAIMAKER_API_KEY");

    cap = captureErr();
    await run(["--uninstall", "--codex", "--dir", dir]);
    cap.restore();
    expect(fs.readFileSync(path.join(dir, ".zshrc"), "utf8")).not.toContain("HAIMAKER_API_KEY");
  });
});
