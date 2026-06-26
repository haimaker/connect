import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/**
 * Atomically write `contents` to `path`, then restrict permissions to 0600.
 *
 * We write to a temp file in the SAME directory (so rename is atomic on the
 * same filesystem) and then rename over the target. The final file is
 * chmod 0o600 — appropriate for files that carry the secret API key.
 *
 * If the target is a symlink (common with Stow/Chezmoi-style dotfile setups) we
 * resolve it and write through to the real file, so we update the user's
 * managed config instead of clobbering the symlink with a regular file.
 */
export async function secureWrite(filePath: string, contents: string): Promise<void> {
  const target = await resolveSymlinkTarget(filePath);
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`);

  // Create the temp file with restrictive mode from the start.
  await fs.promises.writeFile(tmp, contents, { mode: 0o600 });
  try {
    await fs.promises.rename(tmp, target);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  // Ensure mode is 0600 even if the target pre-existed with another mode.
  await fs.promises.chmod(target, 0o600);
}

/**
 * If `filePath` is a symlink, return the real path it points at (so we write
 * through the link rather than replacing it). For a dangling symlink, return the
 * link's intended target. Non-symlinks (and missing paths) return `filePath`.
 */
async function resolveSymlinkTarget(filePath: string): Promise<string> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return filePath;
    throw err;
  }
  if (!st.isSymbolicLink()) return filePath;

  try {
    return await fs.promises.realpath(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Dangling symlink: write to where it points.
    const link = await fs.promises.readlink(filePath);
    return path.resolve(path.dirname(filePath), link);
  }
}

/**
 * Read a file's contents, returning null if it does not exist.
 */
export async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
