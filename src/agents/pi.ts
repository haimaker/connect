// Pi coding agent writer — OpenAI-compatible Chat Completions surface.
//
// Stock Pi keeps user configuration under ~/.pi/agent. Custom providers and
// models live in models.json, credentials live in auth.json, and the default
// selection lives in settings.json. Rebranded Pi builds can change the app name
// and config directory; this writer intentionally targets the stock `pi` build.
// Pi accepts JSONC in models.json, but connect's shared JSON editor rewrites it
// as plain JSON and therefore does not preserve comments.

import * as fs from "fs";
import * as path from "path";
import lockfile from "proper-lockfile";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import { baseUrlForSurface, haimakerModelLabel, haimakerModelRef } from "../endpoint";
import { verifyForCtx } from "../verify";
import { homeRoot } from "./paths";
import { dirExists, pathExists } from "../fs/exists";
import { editJsonConfig } from "../fs/json-config";
import { deleteDeep, setDeep } from "../fs/managed-block";
import { secureWrite } from "../fs/secure-write";

const PROVIDER_ID = "haimaker";
// Haimaker's auto-router spans models with different limits and prices, while
// Pi requires one static model record. These conservative limits avoid Pi's
// much larger 128k/16k defaults; capabilities stay enabled so the router can
// choose an image/reasoning-capable upstream. Dynamic route cost cannot be
// represented by Pi's static per-model cost fields, so cost remains zero.
const ROUTER_CONTEXT_WINDOW = 32768;
const ROUTER_MAX_TOKENS = 4096;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonObject(value: unknown, fileName: string): asserts value is Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new Error(
      `Pi ${fileName} must contain a JSON object. The invalid file was not modified; ` +
        `fix it or restore it from its .haimaker.bak backup.`
    );
  }
}

function agentDir(scope: Scope): string {
  // scope.dir is connect's explicit --dir/test sandbox override and therefore
  // intentionally wins over Pi's ambient environment variable.
  if (!scope.dir) {
    const configured = process.env.PI_CODING_AGENT_DIR;
    if (configured) {
      if (configured === "~") return homeRoot(scope);
      if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
        return path.join(homeRoot(scope), configured.slice(2));
      }
      // Match Pi's normalizePath(): relative values remain relative to cwd.
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

function managedModelIds(provider: unknown): Set<string> {
  if (
    !isJsonObject(provider) ||
    provider.name !== "Haimaker" ||
    provider.api !== "openai-completions" ||
    !Array.isArray(provider.models)
  ) {
    return new Set();
  }
  return new Set(
    provider.models
      .filter(isJsonObject)
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
  );
}

async function withAuthLock<T>(scope: Scope, operation: (target: string) => Promise<T>): Promise<T> {
  const target = authPath(scope);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      stale: 30000,
      retries: { retries: 10, factor: 2, minTimeout: 20, maxTimeout: 2000, randomize: true },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error(`Pi auth.json is busy. Close other Pi/connect processes and re-run.`);
    }
    throw err;
  }

  try {
    return await operation(target);
  } finally {
    await release();
  }
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
    const previousManagedModelIds = new Set<string>();
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
        for (const id of managedModelIds(config.providers?.[PROVIDER_ID])) {
          previousManagedModelIds.add(id);
        }
        setDeep(config, ["providers", PROVIDER_ID], {
          name: "Haimaker",
          baseUrl: baseUrlForSurface(ctx.host, this.surface),
          api: "openai-completions",
          models: [
            {
              id: key,
              name: haimakerModelLabel(key),
              reasoning: true,
              input: ["text", "image"],
              contextWindow: ROUTER_CONTEXT_WINDOW,
              maxTokens: ROUTER_MAX_TOKENS,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        });
      },
      { backup: true, createIfMissing: true }
    );

    await withAuthLock(ctx.scope, async (target) => {
      // When auth.json did not exist, reserve an empty original backup now so a
      // later connect run cannot snapshot the Haimaker key into the backup.
      if (!(await pathExists(target)) && !(await pathExists(`${target}.haimaker.bak`))) {
        await secureWrite(`${target}.haimaker.bak`, "{}\n");
      }
      await editJsonConfig(
        target,
        (auth) => {
          assertJsonObject(auth, "auth.json");
          const existing = auth[PROVIDER_ID];
          const existingEnv = isJsonObject(existing) && isJsonObject(existing.env)
            ? Object.fromEntries(
                Object.entries(existing.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
              )
            : undefined;
          setDeep(auth, [PROVIDER_ID], {
            type: "api_key",
            key: escapedApiKey,
            ...(existingEnv && Object.keys(existingEnv).length > 0 ? { env: existingEnv } : {}),
          });
        },
        { backup: true, createIfMissing: true }
      );
    });

    await editJsonConfig(
      settingsPath(ctx.scope),
      (settings) => {
        assertJsonObject(settings, "settings.json");
        // Do not replace a user's selected provider/model. Once the default is
        // ours, a later connect run may update it to the newly selected model.
        const ownsDefault =
          (settings.defaultProvider == null && settings.defaultModel == null) ||
          (settings.defaultProvider === PROVIDER_ID &&
            typeof settings.defaultModel === "string" &&
            previousManagedModelIds.has(settings.defaultModel));
        if (ownsDefault) {
          settings.defaultProvider = PROVIDER_ID;
          settings.defaultModel = key;
        }
      },
      { backup: true, createIfMissing: true }
    );
  },

  verify(ctx: InstallCtx): Promise<VerifyResult> {
    return verifyForCtx(this.surface, { ...ctx, model: haimakerModelRef(ctx.model).key });
  },

  async uninstall(scope: Scope): Promise<void> {
    const removedManagedModelIds = new Set<string>();
    await editJsonConfig(
      this.configPath(scope),
      (config) => {
        assertJsonObject(config, "models.json");
        if (config.providers !== undefined) {
          assertJsonObject(config.providers, 'models.json "providers"');
          for (const id of managedModelIds(config.providers[PROVIDER_ID])) {
            removedManagedModelIds.add(id);
          }
        }
        deleteDeep(config, ["providers", PROVIDER_ID]);
        // Pi's models.json schema requires the providers key even when empty.
        if (config.providers === undefined) config.providers = {};
      },
      { createIfMissing: false }
    );

    const target = authPath(scope);
    if ((await pathExists(target)) || (await pathExists(`${target}.haimaker.bak`))) {
      await withAuthLock(scope, async () => {
        for (const candidate of [target, `${target}.haimaker.bak`]) {
          await editJsonConfig(
            candidate,
            (auth) => {
              assertJsonObject(auth, path.basename(candidate));
              deleteDeep(auth, [PROVIDER_ID]);
            },
            { createIfMissing: false }
          );
        }
      });
    }

    await editJsonConfig(
      settingsPath(scope),
      (settings) => {
        if (
          settings.defaultProvider === PROVIDER_ID &&
          typeof settings.defaultModel === "string" &&
          removedManagedModelIds.has(settings.defaultModel)
        ) {
          deleteDeep(settings, ["defaultProvider"]);
          deleteDeep(settings, ["defaultModel"]);
        }
      },
      { createIfMissing: false }
    );
  },
};
