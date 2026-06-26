import { DEFAULT_MODEL } from "./endpoint";

export type FetchLike = typeof fetch;

/** Default per-request network timeout. Keeps the CLI from hanging forever. */
export const REQUEST_TIMEOUT_MS = 15000;

/** Cap on models pulled from a (possibly hostile) /v1/models response. */
const MAX_MODELS = 1000;

/** Hard cap on the /v1/models response body, enforced before parsing. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

/**
 * Read and JSON-parse a response body with a hard byte cap, so a hostile or
 * misconfigured host can't force unbounded memory allocation. Rejects early on
 * an oversized Content-Length, then streams with a running cap. Falls back to
 * res.json() when the body isn't a stream (e.g. an injected mock in tests).
 */
async function readJsonCapped(res: Response, maxBytes: number): Promise<ModelsResponse> {
  const lenHeader =
    res.headers && typeof res.headers.get === "function"
      ? res.headers.get("content-length")
      : null;
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error(`models response too large (${lenHeader} bytes).`);
  }

  const body = (res as unknown as { body?: ReadableStream<Uint8Array> }).body;
  if (!body || typeof body.getReader !== "function") {
    return (await res.json()) as ModelsResponse;
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelsResponse;
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
 * Fetch the available model ids from GET {host}/v1/models.
 *
 * - Sends Authorization: Bearer <apiKey>.
 * - Parses OpenAI-style { data: [{ id }] }.
 * - FILTERS OUT wildcard rows (any id containing "*", e.g. "*", "openai/*").
 * - INJECTS "haimaker/auto" as the first element (the /v1/models listing does
 *   not include it), de-duplicating if it already appears.
 *
 * Accepts an injectable fetch for tests. Throws on non-200.
 */
export async function fetchModels(
  host: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<string[]> {
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

  const body = await readJsonCapped(res, MAX_RESPONSE_BYTES);
  const rows = Array.isArray(body?.data) ? body.data.slice(0, MAX_MODELS) : [];

  const deduped: string[] = [];
  const seen = new Set<string>([DEFAULT_MODEL]);
  for (const row of rows) {
    const id = row && typeof row.id === "string" ? row.id : "";
    if (!id || id.includes("*") || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }

  return [DEFAULT_MODEL, ...deduped];
}
