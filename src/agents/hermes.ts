// Hermes writer — config-only custom provider (no Python plugin).
//
// Hermes resolves OpenAI-compatible endpoints from ~/.hermes/config.yaml. We
// register a named custom provider "haimaker" (chat-completions surface) and,
// when we own the active selection, point Hermes at it. The secret is NOT placed
// in config.yaml: Hermes auto-loads ~/.hermes/.env, so we write HAIMAKER_API_KEY
// there (0600) and reference it from the provider via `key_env`.
//
// config.yaml is the user's primary, hand-edited config, so we edit it with the
// `yaml` parser's Document API (lazy-loaded) to preserve comments and formatting,
// touching only the keys we own. See custom-provider-configuration.md.

import * as os from "os";
import * as path from "path";
import type { YAMLSeq } from "yaml";

import { AgentWriter, InstallCtx, Scope, VerifyResult } from "./types";
import { baseUrlForSurface } from "../endpoint";
import { verifyForCtx } from "../verify";
import { dirExists } from "../fs/exists";
import { backupOnce } from "../fs/backup";
import { secureWrite, readIfExists } from "../fs/secure-write";
import { upsertEnvVar, removeEnvVar } from "../fs/env-file";

/** Provider id under custom_providers[].name (and the `custom:<id>` selector). */
const PROVIDER_ID = "haimaker";
/** The `model.provider` value that marks Hermes as pointed at us. */
const PROVIDER_SELECTOR = `custom:${PROVIDER_ID}`;
/** Env var Hermes reads the key from; we write it into ~/.hermes/.env. */
const ENV_KEY = "HAIMAKER_API_KEY";
/**
 * Hermes' factory-default provider (auto-routing). We treat it like "unset": a
 * default install should be activated, matching how every other writer claims an
 * unset default model. A deliberately-chosen named provider is still preserved.
 */
const DEFAULT_PROVIDER = "auto";

/** Resolve the Hermes home dir, honoring scope.dir (tests) and HERMES_HOME. */
function hermesHome(scope: Scope): string {
  if (scope.dir) return path.join(scope.dir, ".hermes");
  const home = process.env.HERMES_HOME;
  if (home && home.trim()) return home;
  return path.join(os.homedir(), ".hermes");
}

function configPathFor(scope: Scope): string {
  return path.join(hermesHome(scope), "config.yaml");
}
function envPathFor(scope: Scope): string {
  return path.join(hermesHome(scope), ".env");
}

/**
 * True when we may own the active model selection: it is unset, Hermes' default
 * "auto", or already ours. A user who deliberately picked a named provider keeps
 * it (they can switch with `/model custom:haimaker:...`).
 */
function ownsSelection(provider: unknown): boolean {
  return (
    provider == null ||
    provider === DEFAULT_PROVIDER ||
    provider === PROVIDER_SELECTOR
  );
}

export const hermesWriter: AgentWriter = {
  id: "hermes",
  displayName: "Hermes",
  surface: "chat",
  // Hermes supports both a `key_env` reference (key in the auto-loaded .env) and
  // an inline `api_key` in config.yaml, so the key-mode choice changes where the
  // secret lives.
  keyModeAware: true,

  async detect(scope: Scope): Promise<boolean> {
    return dirExists(hermesHome(scope));
  },

  configPath(scope: Scope): string {
    return configPathFor(scope);
  },

  async configure(ctx: InstallCtx): Promise<void> {
    const yamlPath = configPathFor(ctx.scope);
    const envPath = envPathFor(ctx.scope);
    const baseUrl = baseUrlForSurface(ctx.host, this.surface);

    // 1. config.yaml — register our provider; own the active selection only when
    //    it is unset or already ours. Comments/formatting are preserved.
    await backupOnce(yamlPath);
    const YAML = await import("yaml");
    const existingYaml = (await readIfExists(yamlPath)) ?? "";
    const doc = YAML.parseDocument(existingYaml);
    if (doc.errors.length > 0) {
      throw new Error(
        `~/.hermes/config.yaml could not be parsed (${doc.errors[0].message}). ` +
          `Fix it or restore from ${yamlPath}.haimaker.bak, then re-run.`
      );
    }
    // Initialize an empty mapping when the file is absent/empty. The created
    // node isn't a "Parsed" node, but it's valid at runtime — cast to satisfy
    // the Document.Parsed contents type.
    if (doc.contents == null) {
      doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
    }

    // Upsert custom_providers[name=haimaker], preserving sibling entries.
    let seq = doc.get("custom_providers");
    if (!YAML.isSeq(seq)) {
      seq = doc.createNode([]);
      doc.set("custom_providers", seq);
    }
    const providers = seq as YAMLSeq;
    providers.items = providers.items.filter(
      (it) => !(YAML.isMap(it) && it.get("name") === PROVIDER_ID)
    );
    // "inline" embeds the literal key in config.yaml (most convenient, most
    // dangerous); "env"/"profile" reference the key from the auto-loaded .env.
    const inline = (ctx.keyMode ?? "env") === "inline";
    const providerNode: Record<string, unknown> = {
      name: PROVIDER_ID,
      base_url: baseUrl,
      api_mode: "chat_completions",
      model: ctx.model,
    };
    if (inline) providerNode.api_key = ctx.apiKey;
    else providerNode.key_env = ENV_KEY;
    providers.add(doc.createNode(providerNode));

    if (ownsSelection(doc.getIn(["model", "provider"]))) {
      doc.setIn(["model", "provider"], PROVIDER_SELECTOR);
      doc.setIn(["model", "default"], ctx.model);
    }

    // In env/profile mode config.yaml holds NO secret (it's in .env via key_env);
    // in inline mode it DOES (api_key above). Either way written atomically 0600.
    await secureWrite(yamlPath, doc.toString());

    // ~/.hermes/.env — the secret, in env/profile mode (Hermes auto-loads it). In
    // inline mode the key lives in config.yaml, so make sure a stale .env copy is
    // removed.
    await backupOnce(envPath);
    const existingEnv = (await readIfExists(envPath)) ?? "";
    const nextEnv = inline
      ? removeEnvVar(existingEnv, ENV_KEY)
      : upsertEnvVar(existingEnv, ENV_KEY, ctx.apiKey);
    if (nextEnv !== existingEnv || !inline) {
      await secureWrite(envPath, nextEnv);
    }
  },

  verify(ctx: InstallCtx): Promise<VerifyResult> {
    return verifyForCtx(this.surface, ctx);
  },

  async uninstall(scope: Scope): Promise<void> {
    const yamlPath = configPathFor(scope);
    const envPath = envPathFor(scope);

    const existingYaml = await readIfExists(yamlPath);
    if (existingYaml != null) {
      const YAML = await import("yaml");
      const doc = YAML.parseDocument(existingYaml);
      if (doc.errors.length === 0 && doc.contents != null) {
        let changed = false;

        const seq = doc.get("custom_providers");
        if (YAML.isSeq(seq)) {
          const providers = seq as YAMLSeq;
          const before = providers.items.length;
          providers.items = providers.items.filter(
            (it) => !(YAML.isMap(it) && it.get("name") === PROVIDER_ID)
          );
          if (providers.items.length !== before) changed = true;
          if (providers.items.length === 0) {
            doc.delete("custom_providers");
            changed = true;
          }
        }

        // Reset the active selection only when it still points at us. This also
        // clears a concrete model.default we wrote (keyed off the provider, so
        // there's no leftover even for a non-haimaker/* model id).
        if (doc.getIn(["model", "provider"]) === PROVIDER_SELECTOR) {
          doc.deleteIn(["model", "provider"]);
          doc.deleteIn(["model", "default"]);
          // Prune the `model` map if we emptied it (we created it on install).
          const model = doc.get("model");
          if (YAML.isMap(model) && model.items.length === 0) doc.delete("model");
          changed = true;
        }

        if (changed) await secureWrite(yamlPath, doc.toString());
      }
    }

    const existingEnv = await readIfExists(envPath);
    if (existingEnv != null) {
      const next = removeEnvVar(existingEnv, ENV_KEY);
      if (next !== existingEnv) await secureWrite(envPath, next);
    }
  },
};
