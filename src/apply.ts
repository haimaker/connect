// Shared "configure then optionally verify" routine used by both the flag-driven
// CLI dispatch and the interactive wizard. Kept in its own module so neither
// cli.ts nor wizard.ts has to import the other (avoids a require cycle).

import { AgentWriter, InstallCtx, VerifyResult } from "./agents/types";
import { KEYS_URL, API_KEY_ENV } from "./endpoint";
import { ensureProfileExport, shellProfilePath } from "./fs/shell-profile";

/**
 * Configure (and optionally verify) a list of writers.
 *
 * Configuration runs SERIALLY so the per-agent "✓ configured" lines stay in
 * selection order. Verification — the slow part, one bounded-timeout network
 * request each — runs CONCURRENTLY, and the results are rendered back in
 * selection order. This keeps multi-agent installs from scaling to N×timeout
 * while preserving deterministic, grouped output.
 *
 * The secret API key is NEVER printed. On a verify failure the written config is
 * LEFT in place (the user can re-run with --no-verify or fix their key).
 */
export async function applyAll(
  writers: AgentWriter[],
  ctx: InstallCtx
): Promise<{ configFailures: number; verifyFailures: number }> {
  // Phase 1 — configure serially.
  const configured: AgentWriter[] = [];
  let configFailures = 0;
  for (const writer of writers) {
    if (await configureWriter(writer, ctx)) {
      configured.push(writer);
    } else {
      configFailures++;
    }
  }

  // Key provisioning: in profile/inline mode, set HAIMAKER_API_KEY in the user's
  // shell startup file for agents that read it from the shell env (Codex), so
  // they work without the user knowing how to export an env var.
  await maybeWriteShellExport(configured, ctx);

  const toVerify = ctx.verify ? configured : [];
  if (toVerify.length === 0) return { configFailures, verifyFailures: 0 };

  // Phase 2 — verify concurrently (Promise.all preserves input/selection order).
  const results = await Promise.all(
    toVerify.map((writer) =>
      writer
        .verify(ctx)
        .then((result) => ({ writer, result }))
        .catch((err) => ({
          writer,
          result: { ok: false, message: (err as Error).message } as VerifyResult,
        }))
    )
  );

  // Phase 3 — render in selection order.
  let verifyFailures = 0;
  for (const { writer, result } of results) {
    printVerifyResult(writer, result);
    if (!result.ok) verifyFailures++;
  }
  return { configFailures, verifyFailures };
}

/**
 * In profile/inline mode, write `export HAIMAKER_API_KEY=…` to the shell startup
 * file when a configured agent reads the key from the shell env (Codex). The key
 * value is never printed — only the path and a warning.
 */
async function maybeWriteShellExport(configured: AgentWriter[], ctx: InstallCtx): Promise<void> {
  const mode = ctx.keyMode ?? "env";
  if (mode === "env") return;
  if (!configured.some((w) => w.usesShellEnvKey)) return;

  try {
    const profilePath = await ensureProfileExport(ctx.scope, API_KEY_ENV, ctx.apiKey);
    console.error(
      `! ${API_KEY_ENV} written to ${profilePath} (plaintext). ` +
        `Open a new terminal or run \`source ${profilePath}\` for it to take effect.`
    );
  } catch (err) {
    console.error(
      `✗ Could not write ${API_KEY_ENV} to ${shellProfilePath(ctx.scope)}: ${(err as Error).message}. ` +
        `Export it yourself, or re-run with the default key mode.`
    );
  }
}

/** Configure one writer, printing a ✓/✗ line. Returns whether it succeeded. */
async function configureWriter(writer: AgentWriter, ctx: InstallCtx): Promise<boolean> {
  try {
    await writer.configure(ctx);
  } catch (err) {
    console.error(`✗ ${writer.displayName}: configure failed — ${(err as Error).message}`);
    return false;
  }
  console.error(`✓ ${writer.displayName} configured at ${writer.configPath(ctx.scope)}`);
  return true;
}

/** Render a verify result for one writer (key never printed). */
function printVerifyResult(writer: AgentWriter, result: VerifyResult): void {
  if (result.ok) {
    console.error(`  ${writer.displayName}: verify PASS (HTTP ${result.status ?? 200})`);
    return;
  }
  console.error(
    `  ${writer.displayName}: verify FAIL${result.status ? ` (HTTP ${result.status})` : ""} — ${result.message}`
  );
  if (result.autoRouterHint) {
    console.error(
      `  hint: the haimaker/auto auto-router may be unavailable on this key. ` +
        `Re-run with --model <concrete-id>, or check your key at ${KEYS_URL}.`
    );
  }
  console.error(`  (config left in place; fix the issue and re-run, or pass --no-verify)`);
}
