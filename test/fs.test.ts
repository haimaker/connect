import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTmpDir, cleanup } from "./helpers";
import { secureWrite, readIfExists } from "../src/fs/secure-write";
import { backupOnce } from "../src/fs/backup";
import { ensureGitignored } from "../src/fs/gitignore";
import { upsertEnvVar, removeEnvVar } from "../src/fs/env-file";
import {
  applyTomlManagedBlock,
  removeTomlManagedBlock,
  stripTopLevelTomlKeys,
  parseJsonish,
  setDeep,
  deleteDeep,
  stringifyJson,
  TOML_BEGIN_MARKER,
  TOML_END_MARKER,
} from "../src/fs/managed-block";

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmpDir("connect-fs");
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe("secureWrite", () => {
  it("creates a file with mode 0600", async () => {
    const dir = tmp();
    const f = path.join(dir, "nested", "secret.json");
    await secureWrite(f, "hello");
    const st = fs.statSync(f);
    expect(st.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f, "utf8")).toBe("hello");
  });

  it("overwrites and keeps 0600", async () => {
    const dir = tmp();
    const f = path.join(dir, "secret.json");
    await secureWrite(f, "a");
    await secureWrite(f, "b");
    expect(fs.readFileSync(f, "utf8")).toBe("b");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlink instead of clobbering it (Stow/Chezmoi setups)", async () => {
    const dir = tmp();
    const real = path.join(dir, "store", "settings.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "old");
    const link = path.join(dir, "settings.json");
    fs.symlinkSync(real, link);

    await secureWrite(link, "new");

    // The link is still a symlink, and the real file received the update.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("new");
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  });

  it("readIfExists returns null when absent", async () => {
    const dir = tmp();
    expect(await readIfExists(path.join(dir, "nope"))).toBeNull();
  });
});

describe("backupOnce", () => {
  it("only backs up once", async () => {
    const dir = tmp();
    const f = path.join(dir, "config.toml");
    fs.writeFileSync(f, "original");
    await backupOnce(f);
    const bak = `${f}.haimaker.bak`;
    expect(fs.readFileSync(bak, "utf8")).toBe("original");

    // mutate the live file, back up again -> backup must stay ORIGINAL
    fs.writeFileSync(f, "changed");
    await backupOnce(f);
    expect(fs.readFileSync(bak, "utf8")).toBe("original");
  });

  it("no-ops when source missing", async () => {
    const dir = tmp();
    const f = path.join(dir, "missing.toml");
    await backupOnce(f);
    expect(fs.existsSync(`${f}.haimaker.bak`)).toBe(false);
  });

  it("writes the backup with mode 0600 (a secret-bearing config must not leak via .bak)", async () => {
    const dir = tmp();
    const f = path.join(dir, "config.json");
    fs.writeFileSync(f, '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-secret"}}', { mode: 0o600 });
    await backupOnce(f);
    expect(fs.statSync(`${f}.haimaker.bak`).mode & 0o777).toBe(0o600);
  });
});

describe("ensureGitignored", () => {
  it("is idempotent", async () => {
    const dir = tmp();
    await ensureGitignored(dir, ".haimaker.json");
    await ensureGitignored(dir, ".haimaker.json");
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    const occurrences = content.split("\n").filter((l) => l.trim() === ".haimaker.json").length;
    expect(occurrences).toBe(1);
  });

  it("appends to an existing gitignore preserving entries", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
    await ensureGitignored(dir, ".haimaker.json");
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(content).toContain("node_modules");
    expect(content).toContain(".haimaker.json");
  });
});

describe("env-file", () => {
  it("appends a new var, preserving existing lines and comments", () => {
    const out = upsertEnvVar("# secrets\nOPENAI_API_KEY=sk-1\n", "HAIMAKER_API_KEY", "hm-2");
    expect(out).toBe("# secrets\nOPENAI_API_KEY=sk-1\nHAIMAKER_API_KEY=hm-2\n");
  });

  it("replaces an existing assignment in place (no duplicate)", () => {
    const out = upsertEnvVar("HAIMAKER_API_KEY=old\nFOO=bar\n", "HAIMAKER_API_KEY", "new");
    expect(out).toBe("HAIMAKER_API_KEY=new\nFOO=bar\n");
  });

  it("handles an empty file and a missing trailing newline", () => {
    expect(upsertEnvVar("", "K", "v")).toBe("K=v\n");
    expect(upsertEnvVar("FOO=bar", "K", "v")).toBe("FOO=bar\nK=v\n");
  });

  it("quotes a value that needs it, leaves plain keys unquoted", () => {
    expect(upsertEnvVar("", "K", "hm_abc-123")).toBe("K=hm_abc-123\n");
    expect(upsertEnvVar("", "K", "has space#hash")).toBe('K="has space#hash"\n');
  });

  it("removeEnvVar drops only the named var, preserving the rest", () => {
    const out = removeEnvVar("OPENAI_API_KEY=sk-1\nHAIMAKER_API_KEY=hm-2\n", "HAIMAKER_API_KEY");
    expect(out).toBe("OPENAI_API_KEY=sk-1\n");
  });

  it("removeEnvVar also matches an `export NAME=` form", () => {
    const out = removeEnvVar("export HAIMAKER_API_KEY=hm\nKEEP=1\n", "HAIMAKER_API_KEY");
    expect(out).toBe("KEEP=1\n");
  });
});

describe("managed-block TOML", () => {
  it("round-trips: apply then remove returns to clean", () => {
    const clean = `model = "gpt-5"\n\n[profiles.default]\nx = 1\n`;
    const applied = applyTomlManagedBlock(clean, `base_url = "https://api.haimaker.ai/v1"`);
    expect(applied).toContain("# >>> haimaker managed");
    expect(applied).toContain("# <<< haimaker managed");
    expect(applied).toContain('base_url = "https://api.haimaker.ai/v1"');
    const removed = removeTomlManagedBlock(applied);
    expect(removed).toBe(clean);
  });

  it("replaces an existing block rather than duplicating", () => {
    let doc = "";
    doc = applyTomlManagedBlock(doc, `a = 1`);
    doc = applyTomlManagedBlock(doc, `a = 2`);
    const count = doc.split("# >>> haimaker managed (do not edit between markers) >>>").length - 1;
    expect(count).toBe(1);
    expect(doc).toContain("a = 2");
    expect(doc).not.toContain("a = 1");
  });

  it("appends when there is no table header", () => {
    const doc = applyTomlManagedBlock("top = true\n", `b = 2`);
    expect(doc).toContain("top = true");
    expect(doc).toContain("b = 2");
  });

  it("does not treat a [line] inside a multiline string as a table header", () => {
    // The `[` below is inside a """...""" value; the block must land AFTER it,
    // not be injected into the middle of the string.
    const doc = 'note = """\n[not a section]\n"""\n\n[real.section]\nx = 1\n';
    const applied = applyTomlManagedBlock(doc, `b = 2`);
    const idxBlock = applied.indexOf(TOML_BEGIN_MARKER);
    const idxRealSection = applied.indexOf("[real.section]");
    const idxString = applied.indexOf("[not a section]");
    // Block inserted before the real section but after the multiline string.
    expect(idxString).toBeLessThan(idxBlock);
    expect(idxBlock).toBeLessThan(idxRealSection);
  });

  it("throws on a half-present (corrupt) managed block", () => {
    const onlyBegin = `${TOML_BEGIN_MARKER}\nmodel = "x"\n`;
    expect(() => applyTomlManagedBlock(onlyBegin, "a = 1")).toThrow(/corrupt/i);
    expect(() => removeTomlManagedBlock(onlyBegin)).toThrow(/corrupt/i);
  });

  it("stripTopLevelTomlKeys removes only top-level owned keys, not section keys", () => {
    const toml =
      'model = "old"\nmodel_provider = "openai"\napproval = "ask"\n\n[profiles.x]\nmodel = "keep"\n';
    const out = stripTopLevelTomlKeys(toml, ["model", "model_provider"]);
    // top-level model / model_provider gone...
    expect(out).not.toMatch(/^model = "old"/m);
    expect(out).not.toMatch(/^model_provider/m);
    // ...unrelated top-level key and the section's own `model` preserved.
    expect(out).toContain('approval = "ask"');
    expect(out).toContain('[profiles.x]\nmodel = "keep"');
  });
});

describe("managed-block JSON", () => {
  it("parseJsonish strips comments and trailing commas", () => {
    const text = `{
      // a line comment
      "host": "https://api.haimaker.ai", /* block */
      "nested": { "k": 1, },
    }`;
    const obj = parseJsonish(text);
    expect(obj.host).toBe("https://api.haimaker.ai");
    expect(obj.nested.k).toBe(1);
  });

  it("parseJsonish returns {} for empty input", () => {
    expect(parseJsonish("")).toEqual({});
    expect(parseJsonish("   ")).toEqual({});
  });

  it("parseJsonish does NOT corrupt a comma-then-bracket inside a string value", () => {
    // The old global trailing-comma regex rewrote "Wait, ]" -> "Wait]".
    const obj = parseJsonish('{ "message": "Wait, ]", "other": "a, }", }');
    expect(obj.message).toBe("Wait, ]");
    expect(obj.other).toBe("a, }");
  });

  it("parseJsonish does NOT strip a // inside a string value", () => {
    const obj = parseJsonish('{ "url": "https://api.haimaker.ai/v1" }');
    expect(obj.url).toBe("https://api.haimaker.ai/v1");
  });

  it("setDeep creates nested keys and deleteDeep prunes them", () => {
    const obj: any = parseJsonish(`{"env":{"KEEP":"1"}}`);
    setDeep(obj, ["env", "ANTHROPIC_BASE_URL"], "https://api.haimaker.ai");
    expect(obj.env.ANTHROPIC_BASE_URL).toBe("https://api.haimaker.ai");
    expect(obj.env.KEEP).toBe("1");

    deleteDeep(obj, ["env", "ANTHROPIC_BASE_URL"]);
    expect(obj.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(obj.env.KEEP).toBe("1");
  });

  it("deleteDeep prunes empty ancestor objects", () => {
    const obj: any = {};
    setDeep(obj, ["a", "b", "c"], 1);
    deleteDeep(obj, ["a", "b", "c"]);
    expect(obj.a).toBeUndefined();
  });

  it("stringifyJson is 2-space with trailing newline", () => {
    const out = stringifyJson({ a: 1 });
    expect(out).toBe('{\n  "a": 1\n}\n');
  });
});
