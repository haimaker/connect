import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deviceLogin,
  DeviceDeniedError,
  DeviceExpiredError,
  DeviceLoginUnavailableError,
  pollForToken,
  requestDeviceCode,
} from "../src/device";

const HOST = "https://api.example.com";
const DEVICE_SECRET = "raw-device-secret";
const API_SECRET = "sk-one-time-secret";

const code = {
  device_code: DEVICE_SECRET,
  user_code: "ABCD-EFGH",
  verification_uri: "https://app.example.com/device",
  verification_uri_complete: "https://app.example.com/device?user_code=ABCD-EFGH",
  expires_in: 900,
  interval: 5,
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(...steps: Array<{ status: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps.shift();
    if (!step) throw new Error("unexpected fetch");
    if (step instanceof Error) throw step;
    return response(step.status, step.body);
  }) as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("device login", () => {
  it("prints the anti-phishing block, opens only the complete URL, and polls pending to success", async () => {
    const { impl, calls } = mockFetch(
      { status: 200, body: code },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          api_key: API_SECRET,
          team_id: "team-1",
          balance_usd: 12.5,
          billing_url: "https://app.example.com/billing",
        },
      }
    );
    const output: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      output.push(String(chunk));
      return true;
    });
    const openUrl = vi.fn();

    const result = await deviceLogin(HOST, {
      fetchImpl: impl,
      sleep: async () => {},
      now: () => 0,
      openUrl,
    });

    expect(result).toEqual({
      apiKey: API_SECRET,
      teamId: "team-1",
      balanceUsd: 12.5,
      billingUrl: "https://app.example.com/billing",
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(code.verification_uri_complete);
    expect(calls.map((call) => call.url)).toEqual([
      `${HOST}/v1/device/code`,
      `${HOST}/v1/device/token`,
      `${HOST}/v1/device/token`,
    ]);
    const stderr = output.join("");
    expect(stderr).toContain("  Your code: ABCD-EFGH");
    expect(stderr).toContain("Only approve in the browser if this code matches.");
    expect(stderr).not.toContain(DEVICE_SECRET);
    expect(stderr).not.toContain(API_SECRET);
  });

  it("maps access_denied to DeviceDeniedError without exposing secrets", async () => {
    const { impl } = mockFetch({ status: 400, body: { error: "access_denied" } });
    const error = await pollForToken(HOST, code, {
      fetchImpl: impl,
      sleep: async () => {},
      now: () => 0,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DeviceDeniedError);
    expect(String(error)).not.toContain(DEVICE_SECRET);
  });

  it("keeps polling past expires_in for a Checkout, then expires from the injected clock", async () => {
    let current = 1000;
    const pending = { status: 400, body: { error: "authorization_pending" } };
    const { impl, calls } = mockFetch(pending, pending, pending);
    await expect(
      pollForToken(HOST, { ...code, expires_in: 2, interval: 600 }, {
        fetchImpl: impl,
        sleep: async (ms) => {
          current += ms;
        },
        now: () => current,
      })
    ).rejects.toBeInstanceOf(DeviceExpiredError);
    // expires_in (2 s) + the 35-minute Checkout allowance, at a 10-minute interval.
    expect(calls).toHaveLength(3);
  });

  it("permanently adds five seconds after slow_down", async () => {
    const { impl } = mockFetch(
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { api_key: API_SECRET } }
    );
    const sleeps: number[] = [];
    await pollForToken(HOST, { ...code, interval: 2 }, {
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    });
    expect(sleeps).toEqual([2000, 7000, 7000]);
  });

  it.each([
    ["network error", new Error("offline")],
    ["non-200", { status: 503, body: { error: "down" } }],
  ])("maps an unavailable code endpoint (%s) to DeviceLoginUnavailableError", async (_name, step) => {
    const { impl } = mockFetch(step);
    await expect(requestDeviceCode(HOST, "host", { fetchImpl: impl })).rejects.toBeInstanceOf(
      DeviceLoginUnavailableError
    );
  });

  it("maps a malformed 200 code response to DeviceLoginUnavailableError", async () => {
    const { impl } = mockFetch({ status: 200, body: { user_code: "ABCD-EFGH" } });
    await expect(requestDeviceCode(HOST, "host", { fetchImpl: impl })).rejects.toBeInstanceOf(
      DeviceLoginUnavailableError
    );
  });

  it("retries a transient poll network error on the next tick", async () => {
    const { impl, calls } = mockFetch(
      new Error("temporary"),
      { status: 200, body: { api_key: API_SECRET } }
    );
    const result = await pollForToken(HOST, code, {
      fetchImpl: impl,
      sleep: async () => {},
      now: () => 0,
    });
    expect(result.apiKey).toBe(API_SECRET);
    expect(calls).toHaveLength(2);
  });

  it("keeps polling through a 5xx and gives up only on a non-400 4xx", async () => {
    const { impl, calls } = mockFetch(
      { status: 502, body: "bad gateway" },
      { status: 503, body: { error: "unavailable" } },
      { status: 200, body: { api_key: API_SECRET } }
    );
    const result = await pollForToken(HOST, code, {
      fetchImpl: impl,
      sleep: async () => {},
      now: () => 0,
    });
    expect(result.apiKey).toBe(API_SECRET);
    expect(calls).toHaveLength(3);

    const notFound = mockFetch({ status: 404, body: { error: "nope" } });
    await expect(
      pollForToken(HOST, code, { fetchImpl: notFound.impl, sleep: async () => {}, now: () => 0 })
    ).rejects.toBeInstanceOf(DeviceLoginUnavailableError);
  });

  it("parses a well-formed topup and omits a malformed one", async () => {
    const good = mockFetch({
      status: 200,
      body: {
        api_key: API_SECRET,
        topup: {
          x402_url: `${HOST}/payments/x402/topup`,
          min_usd: 5,
          network: "eip155:8453",
          asset: "USDC",
        },
      },
    });
    const withTopup = await pollForToken(HOST, code, {
      fetchImpl: good.impl,
      sleep: async () => {},
      now: () => 0,
    });
    expect(withTopup.topup).toEqual({
      x402_url: `${HOST}/payments/x402/topup`,
      min_usd: 5,
      network: "eip155:8453",
      asset: "USDC",
    });

    const malformed = mockFetch({
      status: 200,
      body: { api_key: API_SECRET, topup: { x402_url: `${HOST}/topup` } },
    });
    const withoutTopup = await pollForToken(HOST, code, {
      fetchImpl: malformed.impl,
      sleep: async () => {},
      now: () => 0,
    });
    expect(withoutTopup.topup).toBeUndefined();
  });
});
