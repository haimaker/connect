import * as fs from "fs";

/**
 * Filesystem existence checks shared by the writers (detect()) and backup.
 * ENOENT means "absent" -> false; any other error propagates.
 */

/** True if `p` exists (file, directory, or otherwise). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** True if `p` exists and is a directory. */
export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
