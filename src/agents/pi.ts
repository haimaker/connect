// Pi coding agent writer — OpenAI-compatible Chat Completions surface.
//
// Pi keeps user configuration under ~/.pi/agent. Custom providers and models
// live in models.json, credentials live in auth.json, and the default selection
// lives in settings.json. Keeping the key in auth.json follows Pi's native
// credential-storage layout instead of embedding it in the model catalog.

import * as path from "path";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import { baseUrlForSurface, haimakerModelLabel, haimakerModelRef } from "../endpoint";
import { verifyForCtx } from "../verify";
import { homeRoot } from "./paths";
import { dirExists } from "../fs/exists";
import { editJsonConfig } from "../fs/json-config";
import { deleteDeep, setDeep } from "../fs/managed-block";

const PROVIDER_ID = "haimaker";

function assertJsonObject(value: unknown, fileName: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Pi ${fileName} must contain a JSON object. The invalid file was not modified; ` +
        `fix it or restore it from its .haimaker.bak backup.`
    );
  }
}

function agentDir(scope: Scope): string {
  if (!scope.dir) {
    const configured = process.env.PI_CODING_AGENT_DIR;
    if (configured) {
      if (configured === "~") return homeRoot(scope);
      if (configured.startsWith("~/") || configured.startsWith("~\\")) {
        return path.join(homeRoot(scope), configured.slice(2));
      }
      if (!path.isAbsolute(configured)) {
        throw new Error(
          `PI_CODING_AGENT_DIR must be an absolute path or start with ~/ (got ${JSON.stringify(configured)}).`
        );
      }
      return configured;
    }
  }
  return path.join(homeRoot(scope), ".pi", "agent");
}

function authPath(scope: Scope): string {
  return path.join(agentDir(scope), "auth.json");
}

function settingsPath(scope: Scope): string {
  return path.join(agentDir(scope), "settings.json");
}

export const piWriter: AgentWriter = {
  id: "pi",
  displayName: "Pi",
  surface: "chat",

  async detect(scope: Scope): Promise<boolean> {
    return dirExists(agentDir(scope));
  },

  configPath(scope: Scope): string {
    return path.join(agentDir(scope), "models.json");
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const { key } = haimakerModelRef(ctx.model);
    // Pi resolves `$NAME` and leading `!command` syntax in stored credentials.
    // Escape both forms so an API key is always treated as the literal value
    // supplied to connect.
    const escapedApiKey = ctx.apiKey
      .replace(/\$/g, () => "$$")
      .replace(/^!/, () => "$!");

    await editJsonConfig(
      this.configPath(ctx.scope),
      (config) => {
        assertJsonObject(config, "models.json");
        if (config.providers !== undefined) {
          assertJsonObject(config.providers, 'models.json "providers"');
        }
        setDeep(config, ["providers", PROVIDER_ID], {
          name: "Haimaker",
          baseUrl: baseUrlForSurface(ctx.host, this.surface),
          api: "openai-completions",
          models: [
            {
              id: ctx.model,
              name: haimakerModelLabel(key),
            },
          ],
        });
      },
      { backup: true, createIfMissing: true }
    );

    await editJsonConfig(
      authPath(ctx.scope),
      (auth) => {
        assertJsonObject(auth, "auth.json");
        setDeep(auth, [PROVIDER_ID], { type: "api_key", key: escapedApiKey });
      },
      { backup: true, createIfMissing: true }
    );

    await editJsonConfig(
      settingsPath(ctx.scope),
      (settings) => {
        assertJsonObject(settings, "settings.json");
        // Do not replace a user's selected provider/model. Once the default is
        // ours, a later connect run may update it to the newly selected model.
        const ownsDefault =
          settings.defaultProvider === PROVIDER_ID ||
          (settings.defaultProvider == null && settings.defaultModel == null);
        if (ownsDefault) {
          settings.defaultProvider = PROVIDER_ID;
          settings.defaultModel = ctx.model;
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
        deleteDeep(config, ["providers", PROVIDER_ID]);
      },
      { createIfMissing: false }
    );

    await editJsonConfig(
      authPath(scope),
      (auth) => {
        deleteDeep(auth, [PROVIDER_ID]);
      },
      { createIfMissing: false }
    );

    await editJsonConfig(
      settingsPath(scope),
      (settings) => {
        if (settings.defaultProvider === PROVIDER_ID) {
          deleteDeep(settings, ["defaultProvider"]);
          deleteDeep(settings, ["defaultModel"]);
        }
      },
      { createIfMissing: false }
    );
  },
};
