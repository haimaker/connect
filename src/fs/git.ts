import { execFile } from "child_process";

/**
 * Whether `relPath` is tracked by git within `repoRoot`.
 *
 * Returns false when git is unavailable or the directory is not a repository —
 * in that case we can't tell, so we don't block (gitignore handling still
 * applies). Used to refuse writing a secret-bearing project config into a file
 * that is already tracked, where `.gitignore` would not protect it.
 */
export function isGitTracked(repoRoot: string, relPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relPath],
      (err) => resolve(!err)
    );
  });
}
