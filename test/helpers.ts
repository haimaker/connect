import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Create a unique temp directory under os.tmpdir() for a filesystem test.
 * Always pair with cleanup() in a finally / afterEach.
 */
export function makeTmpDir(prefix: string): string {
  const base = path.join(os.tmpdir(), `${prefix}-`);
  return fs.mkdtempSync(base);
}

/** Recursively remove a temp directory. Best-effort; never throws. */
export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
