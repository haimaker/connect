import * as path from "path";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import {
  baseUrlForSurface,
  isHaimakerModel,
  ownsModelValue,
  haimakerModelRef,
  haimakerModelLabel,
} from "../endpoint";
import { verifyForCtx } from "../verify";
import { homeRoot } from "./paths";
import { dirExists } from "../fs/exists";
import { editJsonConfig } from "../fs/json-config";
import { setDeep, deleteDeep } from "../fs/managed-block";

// ---------------------------------------------------------------------------
// openclaw (surface "chat") — STABLE.
//
// Config path + schema verified against a real install (openclaw 2026.6.10 on
// macOS): the user-global config is ~/.openclaw/openclaw.json, and our block
// matches openclaw's documented JSON schema (`openclaw config validate` passes;
// `openclaw infer model run` round-trips through Haimaker). The file is a
// JSON5-ish document: we read it with parseJsonish (tolerant of comments /
// trailing commas) and rewrite it with stringifyJson. Per the shared fs
// contract this is LOSSY for comments — an accepted v1 tradeoff.
//
// We own exactly two key paths and preserve everything else:
//   agents.defaults.model.primary  -> the selected model
//   models.providers.haimaker      -> our provider block (carries the API key)
// ---------------------------------------------------------------------------

/** Directory name openclaw keeps its config under, relative to the home root. */
const OPENCLAW_DIR = ".openclaw";
/** Config file name within OPENCLAW_DIR. */
const OPENCLAW_FILE = "openclaw.json";

export const openclawWriter: AgentWriter = {
  id: "openclaw",
  displayName: "openclaw",
  surface: "chat",

  configPath(scope: Scope): string {
    return path.join(homeRoot(scope), OPENCLAW_DIR, OPENCLAW_FILE);
  },

  async detect(scope: Scope): Promise<boolean> {
    return dirExists(path.join(homeRoot(scope), OPENCLAW_DIR));
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const baseUrl = baseUrlForSurface(ctx.host, this.surface);
    const { key, ref } = haimakerModelRef(ctx.model);

    // Own our provider block and (only when unset or already ours) the default
    // model; everything else is left untouched. setDeep is idempotent.
    await editJsonConfig(
      this.configPath(ctx.scope),
      (obj) => {
        if (ownsModelValue(obj?.agents?.defaults?.model?.primary)) {
          setDeep(obj, ["agents", "defaults", "model", "primary"], ref);
        }
        setDeep(obj, ["models", "providers", "haimaker"], {
          baseUrl,
          apiKey: ctx.apiKey,
          api: "openai-completions",
          models: [
            {
              id: key,
              name: haimakerModelLabel(key),
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        });
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
      (obj) => {
        // Remove our provider block (prunes now-empty ancestor objects).
        deleteDeep(obj, ["models", "providers", "haimaker"]);

        // Reset the default model only if it still points at one of ours.
        if (isHaimakerModel(obj?.agents?.defaults?.model?.primary)) {
          deleteDeep(obj, ["agents", "defaults", "model", "primary"]);
        }
      },
      { createIfMissing: false }
    );
  },
};
