// Codex writer — OpenAI "responses" surface.
//
// Codex talks to /v1/responses with haimaker/auto. This was once gated because
// the auto-router injected an empty tools:[] that upstream rejected (HTTP 400);
// that proxy bug is fixed in prod (responses + haimaker/auto + tool-calls all
// return 200), so Codex now ships ungated and works on the default model.
//
// Target file: ~/.codex/config.toml (honoring scope.dir). We own a
// marker-delimited managed block inside the user's TOML, leaving everything
// else untouched. Codex authenticates by reading the HAIMAKER_API_KEY
// environment variable at runtime (env_key) — the config.toml itself carries
// NO secret. For v1 we do NOT edit the user's shell profile; instead we surface
// guidance that they must export HAIMAKER_API_KEY themselves.

import * as path from "path";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import { baseUrlForSurface } from "../endpoint";
import { verifyForCtx } from "../verify";
import { homeRoot } from "./paths";
import { dirExists } from "../fs/exists";
import { backupOnce } from "../fs/backup";
import { secureWrite, readIfExists } from "../fs/secure-write";
import {
  applyTomlManagedBlock,
  removeTomlManagedBlock,
  stripTopLevelTomlKeys,
  topLevelKeyLines,
  prependTopLevelTomlLines,
  TOML_RESTORE_PREFIX,
} from "../fs/managed-block";

/** Provider key used both as `model_provider` and the `[model_providers.<id>]` table name. */
const PROVIDER_ID = "haimaker";
/** Human-facing provider name written into the config. */
const PROVIDER_NAME = "Haimaker";
/** Env var Codex reads at runtime for the Bearer token (NOT an inline key). */
const ENV_KEY = "HAIMAKER_API_KEY";

/** Top-level keys this writer takes over (and restores on uninstall). */
const OWNED_KEYS = ["model", "model_provider"];

/**
 * Non-secret guidance surfaced after configure(). Codex authenticates via the
 * HAIMAKER_API_KEY environment variable, which we deliberately do NOT write into
 * any shell profile in v1. This string NEVER contains the API key itself.
 */
export const CODEX_ENV_GUIDANCE =
  `Codex authenticates via the ${ENV_KEY} environment variable. ` +
  `Export it in your shell so Codex can connect, e.g. add ` +
  `\`export ${ENV_KEY}=<your-key>\` to ~/.zshrc or ~/.bashrc (then restart your shell).`;

export const codexWriter: AgentWriter = {
  id: "codex",
  displayName: "Codex",
  surface: "responses",
  // Codex reads HAIMAKER_API_KEY from the shell env at runtime and cannot hold a
  // key in config.toml, so the key-mode choice (env vs shell export) matters here.
  keyModeAware: true,
  usesShellEnvKey: true,

  async detect(scope: Scope): Promise<boolean> {
    return dirExists(path.join(homeRoot(scope), ".codex"));
  },

  configPath(scope: Scope): string {
    return path.join(homeRoot(scope), ".codex", "config.toml");
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const target = this.configPath(ctx.scope);

    // Preserve the user's ORIGINAL config exactly once before we mutate it.
    await backupOnce(target);

    const existing = (await readIfExists(target)) ?? "";
    const baseUrl = baseUrlForSurface(ctx.host, this.surface);

    // Build the structured managed-block body with @iarna/toml. Loaded lazily so
    // the dependency is off the startup path for every non-Codex run. No secret
    // here: the key is referenced indirectly through env_key.
    const TOML = await import("@iarna/toml");
    const body = TOML.stringify({
      model_provider: PROVIDER_ID,
      model: ctx.model,
      model_providers: {
        [PROVIDER_ID]: {
          name: PROVIDER_NAME,
          base_url: baseUrl,
          env_key: ENV_KEY,
          wire_api: "responses",
        },
      },
    });

    // We own the top-level `model` and `model_provider` keys. Strip any prior
    // copies before inserting, so the result never has duplicate top-level keys
    // (invalid TOML). To honor the "preserve everything else" contract, the
    // user's ORIGINAL values are stashed as restore-comments inside our block so
    // uninstall can put them back.
    const carriedRestore = existing
      .split("\n")
      .filter((l) => l.startsWith(TOML_RESTORE_PREFIX));
    const withoutBlock = removeTomlManagedBlock(existing);
    // Prefer values carried from a prior run (the true originals); only capture
    // fresh ones on the first run, before we strip them.
    const restoreLines =
      carriedRestore.length > 0
        ? carriedRestore
        : topLevelKeyLines(withoutBlock, OWNED_KEYS).map((l) => `${TOML_RESTORE_PREFIX}${l}`);

    const cleaned = stripTopLevelTomlKeys(withoutBlock, OWNED_KEYS);
    const fullBody = (restoreLines.length ? restoreLines.join("\n") + "\n" : "") + body;
    const next = applyTomlManagedBlock(cleaned, fullBody);

    // Never write a config that doesn't parse (e.g. a leftover [model_providers.haimaker]
    // table would collide with ours). Fail loudly with the backup pointer instead.
    try {
      TOML.parse(next);
    } catch (err) {
      throw new Error(
        `Refusing to write an invalid ~/.codex/config.toml (${(err as Error).message}). ` +
          `Your original is backed up at ${target}.haimaker.bak.`
      );
    }

    await secureWrite(target, next);

    // In "env" mode the user must export the key themselves, so surface the
    // (non-secret) guidance. In "profile"/"inline" mode connect writes the export
    // to the shell startup file for them and prints that separately, so we stay quiet.
    if ((ctx.keyMode ?? "env") === "env") {
      console.error(CODEX_ENV_GUIDANCE);
    }
  },

  async verify(ctx: InstallCtx): Promise<VerifyResult> {
    const result = await verifyForCtx(this.surface, ctx);
    if (!result.ok) return result;
    // The API call succeeded with the in-memory key, but Codex authenticates by
    // reading ENV_KEY from its own runtime environment. Only nag in "env" mode:
    // in profile/inline mode connect has provisioned the var via the shell rc, so
    // a missing var in THIS process doesn't mean Codex will fail in a new shell.
    if ((ctx.keyMode ?? "env") === "env" && !process.env[ENV_KEY]) {
      return {
        ok: false,
        status: result.status,
        message:
          `The API connection works, but ${ENV_KEY} is not set in this environment. ` +
          `Codex reads it at runtime and will fail to authenticate until you export it. ` +
          CODEX_ENV_GUIDANCE,
      };
    }
    return result;
  },

  async uninstall(scope: Scope): Promise<void> {
    const target = this.configPath(scope);
    const existing = await readIfExists(target);
    if (existing == null) return;

    // Restore any top-level values we took over (stashed as restore-comments
    // inside our block), then remove the block.
    const restoreLines = existing
      .split("\n")
      .filter((l) => l.startsWith(TOML_RESTORE_PREFIX))
      .map((l) => l.slice(TOML_RESTORE_PREFIX.length));

    const withoutBlock = removeTomlManagedBlock(existing);
    const next = prependTopLevelTomlLines(withoutBlock, restoreLines);

    // Only rewrite when something actually changed, so we don't disturb
    // (or re-chmod) a file that has no haimaker content.
    if (next !== existing) {
      await secureWrite(target, next);
    }
  },
};
