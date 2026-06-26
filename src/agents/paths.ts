// Shared config-home resolution for writers. Every writer honors scope.dir (the
// --dir / test override) over the real home, so this lives in one place.

import * as os from "os";
import * as path from "path";
import { Scope } from "./types";

/** Base home root, honoring a scope.dir override (tests / --dir). */
export function homeRoot(scope: Scope): string {
  return scope.dir ?? os.homedir();
}

/**
 * XDG config home, honoring scope.dir as a base "home" override.
 * - scope.dir set -> {dir}/.config (keeps tests hermetic; XDG_CONFIG_HOME ignored)
 * - else XDG_CONFIG_HOME if set, otherwise ~/.config
 */
export function xdgConfigHome(scope: Scope): string {
  if (scope.dir) return path.join(scope.dir, ".config");
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) return xdg;
  return path.join(os.homedir(), ".config");
}
