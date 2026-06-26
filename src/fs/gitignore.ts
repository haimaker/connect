import * as fs from "fs";
import * as path from "path";

/**
 * Ensure `relPath` is listed in `{repoRoot}/.gitignore`.
 *
 * Idempotent: if the entry is already present (exact line match, ignoring
 * surrounding whitespace) we do nothing. Creates .gitignore if absent.
 * Used under PROJECT scope so a project-local config carrying a key is not
 * accidentally committed.
 */
export async function ensureGitignored(repoRoot: string, relPath: string): Promise<void> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const entry = relPath.trim();

  let existing = "";
  try {
    existing = await fs.promises.readFile(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = "";
  }

  const alreadyPresent = existing
    .split(/\r?\n/)
    .some((line) => line.trim() === entry);
  if (alreadyPresent) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const addition = `${needsLeadingNewline ? "\n" : ""}${entry}\n`;
  await fs.promises.appendFile(gitignorePath, addition);
}
