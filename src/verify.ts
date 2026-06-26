import { Surface, VerifyResult, InstallCtx } from "./agents/types";
import { KEYS_URL, baseUrlForSurface } from "./endpoint";
import { FetchLike, fetchWithTimeout } from "./models";

/**
 * Timeout for a verify probe. Larger than the model-listing timeout because a
 * single completion can legitimately take a while.
 */
const VERIFY_TIMEOUT_MS = 30000;

/**
 * Output-token budget for a verify probe. Deliberately SMALL: we only assert
 * HTTP 200 + a structurally valid body, never content, and a reasoning
 * auto-router spends whatever budget it is given on hidden thinking — a large
 * budget makes the responses surface take ~40s (and time out) for no benefit.
 */
const VERIFY_MAX_TOKENS = 64;

/**
 * Send ONE minimal request to a surface and assert the connection works.
 *
 * Success criteria: HTTP 200 AND a body that parses as a JSON object. We do
 * NOT require non-empty content — reasoning models can spend their whole token
 * budget on hidden thinking and return an empty message.
 *
 * On non-200 we return ok:false with the status. A 400 typically means the
 * haimaker/auto auto-router is missing/misconfigured on the key, so we set
 * autoRouterHint:true with a message pointing at KEYS_URL or --model.
 *
 * `baseUrl` is already surface-correct:
 *   - messages:  host root        -> we POST {baseUrl}/v1/messages
 *   - chat:      host + "/v1"      -> we POST {baseUrl}/chat/completions
 *   - responses: host + "/v1"      -> we POST {baseUrl}/responses
 */
export async function verifySurface(args: {
  surface: Surface;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<VerifyResult> {
  const { surface, baseUrl, apiKey, model } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? VERIFY_TIMEOUT_MS;

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (surface === "messages") {
    url = `${baseUrl}/v1/messages`;
    headers = {
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    body = {
      model,
      max_tokens: VERIFY_MAX_TOKENS,
      messages: [{ role: "user", content: "ping" }],
    };
  } else if (surface === "chat") {
    url = `${baseUrl}/chat/completions`;
    headers = {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
    body = {
      model,
      max_tokens: VERIFY_MAX_TOKENS,
      messages: [{ role: "user", content: "ping" }],
    };
  } else {
    // responses
    url = `${baseUrl}/responses`;
    headers = {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
    body = {
      model,
      max_output_tokens: VERIFY_MAX_TOKENS,
      input: "ping",
    };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      timeoutMs
    );
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach ${url}: ${(err as Error).message}`,
    };
  }

  const status = res.status;

  if (status !== 200) {
    const autoRouterHint = status === 400;
    let message: string;
    if (autoRouterHint) {
      message =
        `Request failed with HTTP 400. The haimaker/auto auto-router may not be ` +
        `enabled on this key — check your key at ${KEYS_URL}, or re-run with ` +
        `--model <id> to target a concrete model.`;
    } else {
      message = `Request failed with HTTP ${status}.`;
    }
    return { ok: false, status, message, autoRouterHint };
  }

  // 200: assert the body parses as a JSON object.
  try {
    const parsed = await res.json();
    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        status,
        message: "Received HTTP 200 but the body was not a JSON object.",
      };
    }
  } catch (err) {
    return {
      ok: false,
      status,
      message: `Received HTTP 200 but could not parse JSON body: ${(err as Error).message}`,
    };
  }

  return { ok: true, status, message: "Connection verified." };
}

/**
 * Verify a writer's surface from an InstallCtx. The base URL is derived from the
 * (already-normalized) ctx.host for `surface`, so the surface->URL wiring lives
 * here once instead of in every writer's verify().
 */
export function verifyForCtx(surface: Surface, ctx: InstallCtx): Promise<VerifyResult> {
  return verifySurface({
    surface,
    baseUrl: baseUrlForSurface(ctx.host, surface),
    apiKey: ctx.apiKey,
    model: ctx.model,
  });
}
