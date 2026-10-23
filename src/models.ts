import { DEFAULT_MODEL } from "./endpoint";

export type FetchLike = typeof fetch;

/** Default per-request network timeout. Keeps the CLI from hanging forever. */
export const REQUEST_TIMEOUT_MS = 15000;

/** Cap on models pulled from a (possibly hostile) /v1/models response. */
const MAX_MODELS = 1000;

/** Hard cap on the /v1/models response body, enforced before parsing. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

interface ModelsResponse {
  data?: Array<{ id?: unknown; max_input_tokens?: unknown; max_output_tokens?: unknown }>;
}

/** One model from GET /v1/models, with the limits Haimaker reports when known. */
export interface ModelInfo {
  id: string;
  /** Max input (context) tokens, when the API reports it. */
  contextWindow?: number;
  /** Max output tokens, when the API reports it. */
  maxOutputTokens?: number;
}

/**
 * Ids that are not chat models: image, video, audio, speech, embedding,
 * reranking, and moderation models, plus sized image variants like
 * "openai/high/1024-x-1024/gpt-image-1". A coding agent can't use these, and
 * they would crowd its model picker.
 */
const NON_CHAT_MODEL =
  /embed|rerank|moderation|\btts\b|-tts|whisper|transcri|realtime|audio|speech|image|imagine|video|dall-e|\d+-x-\d+/i;

/** True when `id` looks like a chat model a coding agent can use. */
export function isChatModel(id: string): boolean {
  return !NON_CHAT_MODEL.test(id);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Read and JSON-parse a response body with a hard byte cap, so a hostile or
 * misconfigured host can't force unbounded memory allocation. Rejects early on
 * an oversized Content-Length, then streams with a running cap. Falls back to
 * res.json() when the body isn't a stream (e.g. an injected mock in tests).
 */
export async function readJsonCapped<T>(res: Response, maxBytes: number): Promise<T> {
  const lenHeader =
    res.headers && typeof res.headers.get === "function"
      ? res.headers.get("content-length")
      : null;
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error(`models response too large (${lenHeader} bytes).`);
  }

  const body = (res as unknown as { body?: ReadableStream<Uint8Array> }).body;
  if (!body || typeof body.getReader !== "function") {
    return (await res.json()) as T;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`models response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/**
 * Call `fetchImpl` with an AbortController-backed timeout so a stalled TLS
 * handshake or dead endpoint fails fast instead of blocking the CLI forever
 * (especially after config has already been written). Injected fetches in tests
 * resolve immediately, so the timer never fires.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the model catalog from GET {host}/v1/models.
 *
 * - Sends Authorization: Bearer <apiKey>.
 * - Parses OpenAI-style { data: [{ id, max_input_tokens?, max_output_tokens? }] }.
 * - Drops wildcard rows (any id containing "*", e.g. "*", "openai/*") and
 *   non-chat models (see isChatModel).
 * - Puts "haimaker/auto" first (the listing does not include it), then the rest
 *   sorted by id, de-duplicated.
 *
 * Accepts an injectable fetch for tests. Throws on non-200.
 */
export async function fetchModelCatalog(
  host: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<ModelInfo[]> {
  const url = `${host}/v1/models`;
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
    },
    timeoutMs
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch models: HTTP ${res.status}`);
  }

  const body = await readJsonCapped<ModelsResponse>(res, MAX_RESPONSE_BYTES);
  const rows = Array.isArray(body?.data) ? body.data.slice(0, MAX_MODELS) : [];

  const byId = new Map<string, ModelInfo>();
  for (const row of rows) {
    const id = row && typeof row.id === "string" ? row.id.trim() : "";
    if (!id || id === DEFAULT_MODEL || id.includes("*") || byId.has(id) || !isChatModel(id)) continue;
    const info: ModelInfo = { id };
    const contextWindow = positiveInt(row.max_input_tokens);
    const maxOutputTokens = positiveInt(row.max_output_tokens);
    if (contextWindow) info.contextWindow = contextWindow;
    if (maxOutputTokens) info.maxOutputTokens = maxOutputTokens;
    byId.set(id, info);
  }

  const rest = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [{ id: DEFAULT_MODEL }, ...rest];
}

/** Model ids from GET {host}/v1/models: "haimaker/auto" first, chat models only. */
export async function fetchModels(
  host: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<string[]> {
  const catalog = await fetchModelCatalog(host, apiKey, fetchImpl, timeoutMs);
  return catalog.map((m) => m.id);
}

/**
 * The models a writer should register: the fetched catalog when there is one,
 * always including the selected model (first, if the catalog lacks it). Without
 * a catalog this is just the selected model, which is the pre-catalog behavior.
 */
export function modelsToRegister(selected: string, catalog?: readonly ModelInfo[]): ModelInfo[] {
  if (!catalog || catalog.length === 0) return [{ id: selected }];
  if (catalog.some((m) => m.id === selected)) return [...catalog];
  return [{ id: selected }, ...catalog];
}
