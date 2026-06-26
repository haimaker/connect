// Cline writer — configures the Cline CLI (the `cline` command), surface "chat".
//
// Verified against a real install (Cline CLI 3.0.30 / cline 3.89.2 on macOS).
// `cline auth` stores provider config in:
//     ${--data-dir:-~/.cline}/data/settings/providers.json
// shaped as:
//   {
//     "version": 1,
//     "lastUsedProvider": "openai-compatible",
//     "providers": {
//       "openai-compatible": {
//         "settings": { "provider": "openai-compatible", "apiKey": "...",
//                       "model": "...", "baseUrl": "https://api.haimaker.ai/v1" },
//         "tokenSource": "manual"
//       }
//     }
//   }
//
// We own the "openai-compatible" provider slot (Cline keys custom providers by
// adapter type, so there is exactly one) and point it at Haimaker.
//
// NOTE: this configures the Cline *CLI*. The Cline VS Code extension keeps its
// provider config in VS Code's internal global state and the API key in the OS
// keychain (SecretStorage), which a file-writing tool cannot safely set — that
// surface must be configured through the extension UI.

import * as path from "path";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import { baseUrlForSurface, isHaimakerBaseUrl } from "../endpoint";
import { verifyForCtx } from "../verify";
import { homeRoot } from "./paths";
import { dirExists } from "../fs/exists";
import { editJsonConfig } from "../fs/json-config";
import { setDeep, deleteDeep } from "../fs/managed-block";

/** Cline keys an OpenAI-compatible endpoint under this fixed adapter id. */
const PROVIDER_ID = "openai-compatible";

function clineDir(scope: Scope): string {
  return path.join(homeRoot(scope), ".cline");
}

export const clineWriter: AgentWriter = {
  id: "cline",
  displayName: "Cline (CLI)",
  surface: "chat",

  async detect(scope: Scope): Promise<boolean> {
    return dirExists(clineDir(scope));
  },

  configPath(scope: Scope): string {
    return path.join(clineDir(scope), "data", "settings", "providers.json");
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const baseUrl = baseUrlForSurface(ctx.host, this.surface);

    await editJsonConfig(
      this.configPath(ctx.scope),
      (cfg) => {
        if (cfg.version == null) cfg.version = 1;

        // Own the single OpenAI-compatible provider slot and point it at Haimaker.
        // `updatedAt` is REQUIRED by Cline's schema — without it Cline silently
        // discards the file on read, so we always stamp it.
        setDeep(cfg, ["providers", PROVIDER_ID], {
          settings: {
            provider: PROVIDER_ID,
            apiKey: ctx.apiKey,
            model: ctx.model,
            baseUrl,
          },
          updatedAt: new Date().toISOString(),
          tokenSource: "manual",
        });

        // Select it as the active provider.
        cfg.lastUsedProvider = PROVIDER_ID;
      },
      { backup: true, createIfMissing: true }
    );
  },

  verify(ctx: InstallCtx): Promise<VerifyResult> {
    return verifyForCtx(this.surface, ctx);
  },

  async uninstall(scope: Scope): Promise<void> {
    await editJsonConfig(
      this.configPath(scope),
      (cfg) => {
        // Only remove the slot if WE set it (its baseUrl points at Haimaker), so
        // we don't clobber a user's own openai-compatible endpoint.
        const baseUrl = cfg?.providers?.[PROVIDER_ID]?.settings?.baseUrl;
        if (isHaimakerBaseUrl(baseUrl)) {
          deleteDeep(cfg, ["providers", PROVIDER_ID]);
          if (cfg.lastUsedProvider === PROVIDER_ID) {
            deleteDeep(cfg, ["lastUsedProvider"]);
          }
        }
      },
      { createIfMissing: false }
    );
  },
};
