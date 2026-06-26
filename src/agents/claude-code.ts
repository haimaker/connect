// Claude Code writer.
//
// Claude Code reads ~/.claude/settings.json and honors an "env" block whose
// ANTHROPIC_* variables redirect the bundled Anthropic SDK. We point that SDK
// at the haimaker host (messages surface -> bare host root; the SDK appends
// /v1/messages itself) and inject the auth token + model.
//
// We own EXACTLY four keys under "env" and preserve everything else in the
// file (other top-level keys and other env vars). The file carries the secret
// API key, so it is written with secureWrite (atomic + mode 0600).

import * as path from "path";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import { baseUrlForSurface } from "../endpoint";
import { verifyForCtx } from "../verify";
import { homeRoot } from "./paths";
import { dirExists } from "../fs/exists";
import { editJsonConfig } from "../fs/json-config";
import { setDeep, deleteDeep } from "../fs/managed-block";

/** The env keys this writer owns. Anything else under "env" is preserved. */
const ENV_BASE_URL = "ANTHROPIC_BASE_URL";
const ENV_AUTH_TOKEN = "ANTHROPIC_AUTH_TOKEN";
const ENV_MODEL = "ANTHROPIC_MODEL";
const ENV_SMALL_FAST_MODEL = "ANTHROPIC_SMALL_FAST_MODEL";

/** Resolve the ~/.claude directory, honoring a scope.dir override. */
function claudeDir(scope: Scope): string {
  return path.join(homeRoot(scope), ".claude");
}

export const claudeCodeWriter: AgentWriter = {
  id: "claude-code",
  displayName: "Claude Code",
  surface: "messages",

  async detect(scope: Scope): Promise<boolean> {
    return dirExists(claudeDir(scope));
  },

  configPath(scope: Scope): string {
    return path.join(claudeDir(scope), "settings.json");
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const baseUrl = baseUrlForSurface(ctx.host, this.surface);

    // Own exactly these four env keys; setDeep creates "env" if absent and
    // leaves every other key in place.
    await editJsonConfig(
      this.configPath(ctx.scope),
      (obj) => {
        setDeep(obj, ["env", ENV_BASE_URL], baseUrl);
        setDeep(obj, ["env", ENV_AUTH_TOKEN], ctx.apiKey);
        setDeep(obj, ["env", ENV_MODEL], ctx.model);
        setDeep(obj, ["env", ENV_SMALL_FAST_MODEL], ctx.model);
      },
      { backup: true, createIfMissing: true }
    );
  },

  verify(ctx: InstallCtx): Promise<VerifyResult> {
    return verifyForCtx(this.surface, ctx);
  },

  async uninstall(scope: Scope): Promise<void> {
    // Remove only our four keys; deleteDeep prunes the "env" object when it
    // becomes empty, and leaves every unrelated key intact.
    await editJsonConfig(
      this.configPath(scope),
      (obj) => {
        deleteDeep(obj, ["env", ENV_BASE_URL]);
        deleteDeep(obj, ["env", ENV_AUTH_TOKEN]);
        deleteDeep(obj, ["env", ENV_MODEL]);
        deleteDeep(obj, ["env", ENV_SMALL_FAST_MODEL]);
      },
      { createIfMissing: false }
    );
  },
};
