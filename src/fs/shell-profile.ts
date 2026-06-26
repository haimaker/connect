// Write/remove a managed `export VAR="value"` block in the user's shell startup
// file. Used by --key-mode=profile so an env-var agent (Codex) gets
// HAIMAKER_API_KEY set automatically, without the user knowing how to do it.
//
// The block is delimited by marker comments so it can be replaced idempotently
// and removed cleanly on uninstall. The file is written 0600 because it now
// holds a secret.

import * as os from "os";
import * as path from "path";

import { Scope } from "../agents/types";
import { backupOnce } from "./backup";
import { secureWrite, readIfExists } from "./secure-write";

function beginMarker(varName: string): string {
  return `# >>> haimaker connect — ${varName} (managed; safe to delete this block) >>>`;
}
function endMarker(varName: string): string {
  return `# <<< haimaker connect — ${varName} <<<`;
}

/**
 * Best-effort detection of the shell startup file to edit. Honors scope.dir
 * (tests / --dir) as the home root. Picks by $SHELL: zsh -> ~/.zshrc (honoring
 * $ZDOTDIR), bash -> ~/.bashrc, otherwise ~/.profile.
 */
export function shellProfilePath(scope: Scope): string {
  const home = scope.dir ?? os.homedir();
  const shell = (process.env.SHELL || "").toLowerCase();
  if (shell.includes("zsh")) {
    const zdot = !scope.dir && process.env.ZDOTDIR ? process.env.ZDOTDIR : home;
    return path.join(zdot, ".zshrc");
  }
  if (shell.includes("bash")) {
    return path.join(home, ".bashrc");
  }
  return path.join(home, ".profile");
}

/** Escape a value for inclusion in a double-quoted shell string. */
function shEscape(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

/**
 * Insert or replace a managed `export <varName>="<value>"` block in the shell
 * startup file. Returns the path written. Idempotent.
 */
export async function ensureProfileExport(
  scope: Scope,
  varName: string,
  value: string
): Promise<string> {
  const profilePath = shellProfilePath(scope);
  await backupOnce(profilePath);

  const existing = (await readIfExists(profilePath)) ?? "";
  const block = `${beginMarker(varName)}\nexport ${varName}="${shEscape(value)}"\n${endMarker(varName)}`;
  const next = upsertBlock(existing, beginMarker(varName), endMarker(varName), block);

  await secureWrite(profilePath, next);
  return profilePath;
}

/** Remove our managed block for `varName` from the shell startup file. */
export async function removeProfileExport(scope: Scope, varName: string): Promise<void> {
  const profilePath = shellProfilePath(scope);
  const existing = await readIfExists(profilePath);
  if (existing == null) return;
  const next = removeBlock(existing, beginMarker(varName), endMarker(varName));
  if (next !== existing) await secureWrite(profilePath, next);
}

function upsertBlock(existing: string, begin: string, end: string, block: string): string {
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b !== -1 && e !== -1 && e > b) {
    return existing.slice(0, b) + block + existing.slice(e + end.length);
  }
  if (existing.length === 0) return block + "\n";
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}

function removeBlock(existing: string, begin: string, end: string): string {
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b === -1 || e === -1 || e < b) return existing;
  let before = existing.slice(0, b);
  let after = existing.slice(e + end.length);
  // Collapse the separator we introduced so removal round-trips cleanly.
  before = before.replace(/\n+$/, "");
  after = after.replace(/^\n+/, "");
  if (before && after) return `${before}\n${after}`;
  return (before || after) ? `${before}${after}\n` : "";
}
