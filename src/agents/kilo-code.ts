import * as path from "path";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import {
  baseUrlForSurface,
  ownsModelValue,
  isHaimakerModel,
  haimakerModelRef,
  haimakerModelLabel,
} from "../endpoint";
import { verifyForCtx } from "../verify";
import { xdgConfigHome } from "./paths";
import { dirExists } from "../fs/exists";
import { editJsonConfig } from "../fs/json-config";
import { setDeep, deleteDeep } from "../fs/managed-block";

/**
 * Kilo Code writer — OpenAI-style "chat" surface.
 *
 * Config path + schema verified against a real install (Kilo Code 7.3.54 on
 * macOS, the bundled `kilo` CLI). Config lives at
 * ${XDG_CONFIG_HOME:-~/.config}/kilo/kilo.jsonc, the `$schema` is
 * https://app.kilo.ai/config.json, and a custom provider is declared as
 * provider.<name>.{api, options.{apiKey,baseURL}, models.<id>}. The file is
 * treated as JSONC: we parse tolerantly with parseJsonish and rewrite as plain
 * JSON via stringifyJson. Any user comments are lost on rewrite — the accepted
 * v1 tradeoff shared by all JSON/JSONC writers.
 *
 * We own a known set of keys and preserve everything else:
 *   - $schema             (only set if absent)
 *   - provider.haimaker   (fully owned: api + options + models)
 *   - top-level "model"   (only owned when unset or already "haimaker/*")
 */

const SCHEMA_URL = "https://app.kilo.ai/config.json";

function kiloDir(scope: Scope): string {
  return path.join(xdgConfigHome(scope), "kilo");
}

export const kiloCodeWriter: AgentWriter = {
  id: "kilo-code",
  displayName: "Kilo Code",
  surface: "chat",
  // Config path + schema verified end-to-end against a real install (Kilo 7.3.54
  // CLI on macOS): config at ${XDG_CONFIG_HOME:-~/.config}/kilo/kilo.jsonc,
  // `kilo config check` clean, live roll-call round-trips through Haimaker.

  async detect(scope: Scope): Promise<boolean> {
    return dirExists(kiloDir(scope));
  },

  configPath(scope: Scope): string {
    return path.join(kiloDir(scope), "kilo.jsonc");
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const baseURL = baseUrlForSurface(ctx.host, this.surface);
    const { key, ref } = haimakerModelRef(ctx.model);

    await editJsonConfig(
      this.configPath(ctx.scope),
      (config) => {
        // $schema: only set when absent (never clobber a user's value).
        if (config.$schema == null) {
          config.$schema = SCHEMA_URL;
        }

        // provider.haimaker: fully owned, exposing exactly the selected model.
        // `api: "openai-compatible"` is Kilo's OpenAI-compatible adapter.
        setDeep(config, ["provider", "haimaker"], {
          api: "openai-compatible",
          options: {
            apiKey: ctx.apiKey,
            baseURL,
          },
          models: {
            [key]: {
              name: haimakerModelLabel(key),
              tool_call: true,
            },
          },
        });

        // top-level "model": own it only when unset, or already a haimaker/*
        // value (never overwrite a model the user deliberately chose). Stored as
        // a haimaker/* reference so uninstall can recognize and remove it.
        if (ownsModelValue(config.model)) {
          config.model = ref;
        }
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
      (config) => {
        // Remove only our managed provider; prunes an empty `provider` object.
        deleteDeep(config, ["provider", "haimaker"]);

        // Remove the top-level model only if it is one of ours (haimaker/*).
        if (isHaimakerModel(config.model)) {
          deleteDeep(config, ["model"]);
        }
      },
      { createIfMissing: false }
    );
  },
};
