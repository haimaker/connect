// Writer for opencode (https://opencode.ai) — surface "chat".
//
// opencode reads a JSON config:
//   - user scope:    ${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json
//   - project scope: {cwd}/opencode.json
//
// We register a custom provider "haimaker" using the OpenAI-compatible AI SDK
// adapter ("@ai-sdk/openai-compatible") so requests go to /v1/chat/completions.
// We deliberately do NOT use "@ai-sdk/openai" because that adapter targets
// /v1/responses, which is broken with the haimaker/auto auto-router.
//
// The config carries the API key (provider.options.apiKey), so it is written
// with secureWrite (0600) and gitignored under project scope.

import * as fs from "fs";
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
import { ensureGitignored } from "../fs/gitignore";
import { isGitTracked } from "../fs/git";
import { editJsonConfig } from "../fs/json-config";
import { setDeep, deleteDeep } from "../fs/managed-block";

/** Basename of the project-local config (also the .gitignore entry). */
const PROJECT_CONFIG = "opencode.json";

/** Directory that holds the user-level opencode config. */
function userConfigDir(scope: Scope): string {
  return path.join(xdgConfigHome(scope), "opencode");
}

/** Is `name` an executable file on the current PATH? */
function binaryOnPath(name: string): boolean {
  const pathEnv = process.env.PATH || "";
  if (!pathEnv) return false;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, name + ext)).isFile()) return true;
      } catch {
        /* not here; keep looking */
      }
    }
  }
  return false;
}

export const opencodeWriter: AgentWriter = {
  id: "opencode",
  displayName: "opencode",
  surface: "chat",
  projectScope: true,

  async detect(scope: Scope): Promise<boolean> {
    if (await dirExists(userConfigDir(scope))) return true;
    return binaryOnPath("opencode");
  },

  configPath(scope: Scope): string {
    if (scope.kind === "project") {
      return path.join(scope.cwd ?? process.cwd(), PROJECT_CONFIG);
    }
    return path.join(userConfigDir(scope), "opencode.json");
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const baseURL = baseUrlForSurface(ctx.host, this.surface);
    const { key, ref } = haimakerModelRef(ctx.model);

    // Under project scope, protect against committing the key:
    //  1. Refuse if the file is already git-tracked (.gitignore won't help an
    //     already-tracked file — we'd be writing a secret into a tracked file).
    //  2. Otherwise gitignore it BEFORE writing, so a crash between write and
    //     ignore can never leave a secret-carrying file un-ignored.
    if (ctx.scope.kind === "project") {
      const cwd = ctx.scope.cwd ?? process.cwd();
      if (await isGitTracked(cwd, PROJECT_CONFIG)) {
        throw new Error(
          `${PROJECT_CONFIG} is tracked by git, so writing the API key into it could commit a ` +
            `secret. Run \`git rm --cached ${PROJECT_CONFIG}\` (keep it gitignored), then re-run.`
        );
      }
      await ensureGitignored(cwd, PROJECT_CONFIG);
    }

    await editJsonConfig(
      this.configPath(ctx.scope),
      (obj) => {
        // Own the entire "haimaker" provider entry (replace on re-run; idempotent).
        // The provider exposes exactly the selected model, keyed so the agent
        // resolves "haimaker/<key>" to the right upstream model.
        setDeep(obj, ["provider", "haimaker"], {
          npm: "@ai-sdk/openai-compatible",
          name: "Haimaker",
          options: {
            baseURL,
            apiKey: ctx.apiKey,
          },
          models: {
            [key]: { name: haimakerModelLabel(key) },
          },
        });

        // Claim the top-level default only when unset or already ours, and store
        // it as a haimaker/* reference so uninstall can recognize and remove it.
        if (ownsModelValue(obj.model)) {
          obj.model = ref;
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
      (obj) => {
        // Remove our provider; prune empty ancestor objects.
        deleteDeep(obj, ["provider", "haimaker"]);

        // Drop the top-level model only if it still points at a haimaker/* value.
        if (isHaimakerModel(obj.model)) {
          deleteDeep(obj, ["model"]);
        }
      },
      { createIfMissing: false }
    );
  },
};
