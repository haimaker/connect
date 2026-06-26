// Registry of every supported agent writer. Order is the display/priority order
// used by the wizard and by `--uninstall` over all detected agents.

import { AgentWriter, Scope } from "./types";
import { claudeCodeWriter } from "./claude-code";
import { opencodeWriter } from "./opencode";
import { hermesWriter } from "./hermes";
import { codexWriter } from "./codex";
import { clineWriter } from "./cline";
import { kiloCodeWriter } from "./kilo-code";
import { openclawWriter } from "./openclaw";

/** All writers in display/priority order. */
export const ALL_WRITERS: AgentWriter[] = [
  claudeCodeWriter,
  opencodeWriter,
  hermesWriter,
  codexWriter,
  clineWriter,
  kiloCodeWriter,
  openclawWriter,
];

/** Look up a writer by its stable id (e.g. "claude-code"). */
export function byId(id: string): AgentWriter | undefined {
  return ALL_WRITERS.find((w) => w.id === id);
}

/**
 * Detect which of `writers` are installed, preserving their input order.
 * Detection runs concurrently. It is best-effort — a failing detect() is
 * treated as "not installed" — but an UNEXPECTED error (e.g. a permission
 * failure, not a missing directory) is surfaced as a warning so a real problem
 * is not silently hidden behind an empty agent list.
 */
export async function detectInstalled(
  writers: AgentWriter[],
  scope: Scope
): Promise<AgentWriter[]> {
  const installed = await Promise.all(
    writers.map((w) =>
      w.detect(scope).catch((err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.error(`! could not check whether ${w.displayName} is installed: ${(err as Error).message}`);
        }
        return false;
      })
    )
  );
  return writers.filter((_, i) => installed[i]);
}
