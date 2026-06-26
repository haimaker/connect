import * as fs from "fs";
import { pathExists } from "./exists";

/**
 * Back up `path` to `{path}.haimaker.bak` exactly once.
 *
 * If the target file exists AND no backup exists yet, copy it. If a backup
 * already exists we leave it untouched (so we preserve the user's ORIGINAL
 * pre-haimaker config across repeated runs). No-op if the source is missing.
 *
 * The backup is chmod 0600: these configs can hold the secret API key, and
 * copyFile does NOT inherit the source's restrictive mode (it would otherwise
 * create a world-readable 0644 copy of a 0600 secret).
 */
export async function backupOnce(filePath: string): Promise<void> {
  const backupPath = `${filePath}.haimaker.bak`;

  if (!(await pathExists(filePath))) return;
  if (await pathExists(backupPath)) return;

  await fs.promises.copyFile(filePath, backupPath);
  await fs.promises.chmod(backupPath, 0o600);
}
