import { Surface } from "./agents/types";

/** Canonical haimaker API host. No trailing slash. */
export const DEFAULT_HOST = "https://api.haimaker.ai";

/** Default model: the auto-router. Works on chat + messages surfaces. */
export const DEFAULT_MODEL = "haimaker/auto";

/** Namespace prefix for haimaker-managed model ids (e.g. "haimaker/auto"). */
export const MODEL_NS = "haimaker/";

/** Host substring that marks a URL as pointing at haimaker (see DEFAULT_HOST). */
const HAIMAKER_HOST_MARK = "haimaker.ai";

/** True when `model` is one of ours (a haimaker/* id). */
export function isHaimakerModel(model: unknown): boolean {
  return typeof model === "string" && model.startsWith(MODEL_NS);
}

/**
 * True when `url` points at the haimaker host. Best-effort (host substring) —
 * used to recognize a provider slot we wrote when the only ownership signal is
 * the base URL. The canonical host lives here, not duplicated in writers.
 */
export function isHaimakerBaseUrl(url: unknown): boolean {
  return typeof url === "string" && url.includes(HAIMAKER_HOST_MARK);
}

/**
 * True when we may claim the top-level default model: it is unset, or already a
 * haimaker/* value — so we never clobber a model the user deliberately chose.
 */
export function ownsModelValue(model: unknown): boolean {
  return model == null || isHaimakerModel(model);
}

/** Where users go to create an API key. */
export const KEYS_URL = "https://haimaker.ai/keys";

/** The environment variable env-var agents (Codex) read the key from. */
export const API_KEY_ENV = "HAIMAKER_API_KEY";

/**
 * Normalize a user-supplied host.
 * - trims surrounding whitespace
 * - strips trailing slashes
 * - strips a single trailing "/v1" segment (so we never produce "/v1/v1")
 */
export function normalizeHost(input: string): string {
  let h = (input || "").trim();
  // strip trailing slashes
  h = h.replace(/\/+$/, "");
  // strip a trailing /v1 segment
  h = h.replace(/\/v1$/i, "");
  // strip any slashes the /v1 removal exposed
  h = h.replace(/\/+$/, "");
  return h;
}

/**
 * Validate and normalize a host the API key will be sent to.
 *
 * The key is sent as `Authorization: Bearer <key>`, so we refuse to send it
 * anywhere unexpected: the value must parse as a URL and use https:// (http://
 * requires an explicit `allowInsecure` opt-in, since it would put the key on the
 * wire in cleartext). Empty or flag-looking values (a missing `--host` argument
 * that swallowed the next flag) are rejected outright.
 */
export function validateHost(input: string, opts: { allowInsecure?: boolean } = {}): string {
  const raw = (input ?? "").trim();
  if (!raw || raw.startsWith("-")) {
    throw new Error(`--host requires a URL value (got ${JSON.stringify(input)}).`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--host must be a valid URL (got ${JSON.stringify(raw)}).`);
  }
  if (url.protocol === "http:") {
    if (!opts.allowInsecure) {
      throw new Error(
        `--host uses http://, which would send your API key in cleartext. ` +
          `Use https://, or pass --allow-insecure-host to override (local testing only).`
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error(`--host must use https:// (got ${url.protocol}//).`);
  }
  return normalizeHost(url.origin + url.pathname);
}

/**
 * Split a model id into the provider-local key and the haimaker-namespaced
 * reference the provider-based agents (opencode/kilo/openclaw) use.
 *
 * The model name the haimaker API actually receives is everything after the
 * `haimaker/` provider segment:
 *   - "haimaker/auto"   -> { key: "auto",          ref: "haimaker/auto" }
 *   - "openai/gpt-4o"   -> { key: "openai/gpt-4o", ref: "haimaker/openai/gpt-4o" }
 *
 * Keeping the top-level reference inside the `haimaker/` namespace is what makes
 * uninstall able to recognize (and remove) a default we set, even for a concrete
 * model — and it makes the provider expose exactly the selected model.
 */
export function haimakerModelRef(model: string): { key: string; ref: string } {
  const key = isHaimakerModel(model) ? model.slice(MODEL_NS.length) : model;
  return { key, ref: MODEL_NS + key };
}

/** Human label for a provider-local model key ("auto" -> "Haimaker Auto"). */
export function haimakerModelLabel(key: string): string {
  return key === "auto" ? "Haimaker Auto" : `Haimaker ${key}`;
}

/**
 * Derive the base URL an agent should be pointed at for a given surface.
 * - "messages":  bare host root (the Anthropic SDK appends /v1/messages).
 * - "chat"/"responses": host + "/v1" (the OpenAI SDK appends /chat/completions etc).
 *
 * Assumes `host` is already normalized (no trailing slash, no trailing /v1).
 */
export function baseUrlForSurface(host: string, surface: Surface): string {
  const root = normalizeHost(host);
  if (surface === "messages") return root;
  return root + "/v1";
}
