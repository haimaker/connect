import { spawn } from "child_process";
import { hostname } from "os";

import { DEVICE_CLIENT_ID } from "./endpoint";
import { FetchLike, fetchWithTimeout, readJsonCapped, REQUEST_TIMEOUT_MS } from "./models";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTopup {
  x402_url: string;
  min_usd: number;
  network: string;
  asset: string;
}

export interface DeviceTokenSuccess {
  apiKey: string;
  teamId?: string;
  balanceUsd?: number;
  billingUrl?: string;
  topup?: DeviceTopup;
}

export interface DeviceLoginDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  openUrl?: (url: string) => void;
}

export class DeviceDeniedError extends Error {
  constructor() {
    super("Authorization was denied in the browser.");
    this.name = "DeviceDeniedError";
  }
}

export class DeviceExpiredError extends Error {
  constructor() {
    super("The code expired. Rerun connect. If you already paid, your balance is saved.");
    this.name = "DeviceExpiredError";
  }
}

export class DeviceLoginUnavailableError extends Error {
  constructor() {
    super("Device login is unavailable.");
    this.name = "DeviceLoginUnavailableError";
  }
}

const MAX_DEVICE_RESPONSE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseDeviceCode(value: unknown): DeviceCodeResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.device_code) ||
    !isNonEmptyString(value.user_code) ||
    !isNonEmptyString(value.verification_uri) ||
    !isNonEmptyString(value.verification_uri_complete) ||
    !isFiniteNumber(value.expires_in) ||
    value.expires_in <= 0 ||
    !isFiniteNumber(value.interval) ||
    value.interval < 0
  ) {
    return undefined;
  }
  return value as unknown as DeviceCodeResponse;
}

function parseTopup(value: unknown): DeviceTopup | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.x402_url) ||
    !isFiniteNumber(value.min_usd) ||
    !isNonEmptyString(value.network) ||
    !isNonEmptyString(value.asset)
  ) {
    return undefined;
  }
  return {
    x402_url: value.x402_url,
    min_usd: value.min_usd,
    network: value.network,
    asset: value.asset,
  };
}

function parseToken(value: unknown): DeviceTokenSuccess | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.api_key)) return undefined;
  const result: DeviceTokenSuccess = { apiKey: value.api_key };
  if (isNonEmptyString(value.team_id)) result.teamId = value.team_id;
  if (isFiniteNumber(value.balance_usd)) result.balanceUsd = value.balance_usd;
  if (isNonEmptyString(value.billing_url)) result.billingUrl = value.billing_url;
  const topup = parseTopup(value.topup);
  if (topup) result.topup = topup;
  return result;
}

async function readDeviceJson(res: Response): Promise<unknown> {
  try {
    return await readJsonCapped<unknown>(res, MAX_DEVICE_RESPONSE_BYTES);
  } catch {
    throw new DeviceLoginUnavailableError();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOpenUrl(url: string): void {
  if (process.env.SSH_CONNECTION !== undefined || process.env.CI !== undefined) return;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;

  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

function clientHostname(): string {
  return hostname().replace(/\p{Cc}/gu, "").slice(0, 64);
}

export async function requestDeviceCode(
  host: string,
  clientName: string,
  deps: DeviceLoginDeps = {}
): Promise<DeviceCodeResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      `${host}/v1/device/code`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: DEVICE_CLIENT_ID,
          client_name: clientName.replace(/\p{Cc}/gu, "").slice(0, 64),
        }),
      },
      REQUEST_TIMEOUT_MS
    );
  } catch {
    throw new DeviceLoginUnavailableError();
  }
  if (res.status !== 200) throw new DeviceLoginUnavailableError();

  const code = parseDeviceCode(await readDeviceJson(res));
  if (!code) throw new DeviceLoginUnavailableError();
  return code;
}

// Matches the proxy's grant extension for a Checkout session (30 min) plus its
// webhook/polling grace.
const CHECKOUT_ALLOWANCE_SECONDS = 35 * 60;

export async function pollForToken(
  host: string,
  code: DeviceCodeResponse,
  deps: DeviceLoginDeps = {}
): Promise<DeviceTokenSuccess> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  // The server is the authority on expiry (it answers `expired_token`), and
  // it extends a grant while the person is paying in Stripe Checkout. The
  // local deadline only bounds a server that never answers.
  const deadline = now() + (code.expires_in + CHECKOUT_ALLOWANCE_SECONDS) * 1000;
  let intervalMs = code.interval * 1000;

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new DeviceExpiredError();
    await sleep(Math.min(intervalMs, remaining));
    if (now() >= deadline) throw new DeviceExpiredError();

    let res: Response;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        `${host}/v1/device/token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_code: code.device_code, client_id: DEVICE_CLIENT_ID }),
        },
        REQUEST_TIMEOUT_MS
      );
    } catch {
      continue;
    }

    if (res.status === 200) {
      const token = parseToken(await readDeviceJson(res));
      if (!token) throw new DeviceLoginUnavailableError();
      return token;
    }
    // A 5xx mid-poll is an infrastructure blip, not a verdict on the grant;
    // keep waiting until the deadline like a dropped connection.
    if (res.status >= 500) continue;
    if (res.status !== 400) throw new DeviceLoginUnavailableError();

    const body = await readDeviceJson(res);
    const error = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (error === "expired_token") throw new DeviceExpiredError();
    if (error === "access_denied") throw new DeviceDeniedError();
    throw new DeviceLoginUnavailableError();
  }
}

export async function deviceLogin(
  host: string,
  deps: DeviceLoginDeps = {}
): Promise<DeviceTokenSuccess> {
  const code = await requestDeviceCode(host, clientHostname(), deps);
  const minutes = Math.ceil(code.expires_in / 60);
  process.stderr.write(
    `Open ${code.verification_uri_complete}\n\n` +
      `  Your code: ${code.user_code}\n\n` +
      `Only approve in the browser if this code matches. ` +
      `Waiting for authorization… (expires in ${minutes} minutes)\n`
  );
  try {
    (deps.openUrl ?? defaultOpenUrl)(code.verification_uri_complete);
  } catch {
    // Browser opening is best-effort; the printed URL is always sufficient.
  }
  return pollForToken(host, code, deps);
}

export function printDeviceLoginSummary(login: DeviceTokenSuccess): void {
  if (login.balanceUsd !== undefined) {
    const suffix = login.topup ? " Your agent can fund itself with USDC over x402:" : "";
    console.error(`Balance: $${login.balanceUsd.toFixed(2)}.${suffix}`);
  }
  if (login.topup) {
    console.error(
      `  POST ${login.topup.x402_url}  ` +
        `(team ${login.teamId ?? "unknown"}, min $${login.topup.min_usd})`
    );
    console.error("  Guide: https://haimaker.ai/agents");
  }
}
