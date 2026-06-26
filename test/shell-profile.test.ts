import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTmpDir, cleanup } from "./helpers";
import { shellProfilePath, ensureProfileExport, removeProfileExport } from "../src/fs/shell-profile";
import { Scope } from "../src/agents/types";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-profile");
  dirs.push(d);
  return d;
}

let savedShell: string | undefined;
beforeEach(() => {
  savedShell = process.env.SHELL;
  process.env.SHELL = "/bin/zsh"; // deterministic -> .zshrc
});
afterEach(() => {
  if (savedShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = savedShell;
  while (dirs.length) cleanup(dirs.pop()!);
});

function scope(dir: string): Scope {
  return { kind: "user", dir };
}

describe("shellProfilePath", () => {
  it("picks .zshrc for zsh, .bashrc for bash, honoring scope.dir", () => {
    const dir = tmp();
    process.env.SHELL = "/bin/zsh";
    expect(shellProfilePath(scope(dir))).toBe(path.join(dir, ".zshrc"));
    process.env.SHELL = "/bin/bash";
    expect(shellProfilePath(scope(dir))).toBe(path.join(dir, ".bashrc"));
  });
});

describe("ensureProfileExport", () => {
  it("writes a managed export block at mode 0600 and is idempotent", async () => {
    const dir = tmp();
    const p = await ensureProfileExport(scope(dir), "HAIMAKER_API_KEY", "sk-abc");
    expect(p).toBe(path.join(dir, ".zshrc"));

    const first = fs.readFileSync(p, "utf8");
    expect(first).toContain('export HAIMAKER_API_KEY="sk-abc"');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);

    // Re-run with a new value: still exactly one managed block, value updated.
    await ensureProfileExport(scope(dir), "HAIMAKER_API_KEY", "sk-xyz");
    const second = fs.readFileSync(p, "utf8");
    expect(second.match(/>>> haimaker connect — HAIMAKER_API_KEY/g)).toHaveLength(1);
    expect(second).toContain('export HAIMAKER_API_KEY="sk-xyz"');
    expect(second).not.toContain("sk-abc");
  });

  it("appends to and cleanly removes from an existing profile, preserving content", async () => {
    const dir = tmp();
    const p = path.join(dir, ".zshrc");
    fs.writeFileSync(p, "# my zshrc\nexport PATH=/usr/local/bin:$PATH\n");

    await ensureProfileExport(scope(dir), "HAIMAKER_API_KEY", "sk-abc");
    let body = fs.readFileSync(p, "utf8");
    expect(body).toContain("# my zshrc");
    expect(body).toContain("export PATH=/usr/local/bin:$PATH");
    expect(body).toContain('export HAIMAKER_API_KEY="sk-abc"');

    await removeProfileExport(scope(dir), "HAIMAKER_API_KEY");
    body = fs.readFileSync(p, "utf8");
    expect(body).not.toContain("HAIMAKER_API_KEY");
    expect(body).toContain("# my zshrc");
    expect(body).toContain("export PATH=/usr/local/bin:$PATH");
  });

  it("escapes shell-special characters in the value", async () => {
    const dir = tmp();
    const p = await ensureProfileExport(scope(dir), "HAIMAKER_API_KEY", 'a"b$c`d\\e');
    expect(fs.readFileSync(p, "utf8")).toContain('export HAIMAKER_API_KEY="a\\"b\\$c\\`d\\\\e"');
  });

  it("removeProfileExport is a no-op when the file is absent", async () => {
    const dir = tmp();
    await expect(removeProfileExport(scope(dir), "HAIMAKER_API_KEY")).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".zshrc"))).toBe(false);
  });
});
