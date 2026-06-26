import { describe, it, expect } from "vitest";
import {
  normalizeHost,
  baseUrlForSurface,
  validateHost,
  haimakerModelRef,
  haimakerModelLabel,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  KEYS_URL,
} from "../src/endpoint";

describe("normalizeHost", () => {
  it("leaves a plain host unchanged", () => {
    expect(normalizeHost("https://api.haimaker.ai")).toBe("https://api.haimaker.ai");
  });

  it("strips a trailing slash", () => {
    expect(normalizeHost("https://api.haimaker.ai/")).toBe("https://api.haimaker.ai");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeHost("https://api.haimaker.ai///")).toBe("https://api.haimaker.ai");
  });

  it("strips a trailing /v1", () => {
    expect(normalizeHost("https://api.haimaker.ai/v1")).toBe("https://api.haimaker.ai");
  });

  it("strips a trailing /v1/", () => {
    expect(normalizeHost("https://api.haimaker.ai/v1/")).toBe("https://api.haimaker.ai");
  });

  it("trims whitespace", () => {
    expect(normalizeHost("  https://api.haimaker.ai/v1  ")).toBe("https://api.haimaker.ai");
  });
});

describe("baseUrlForSurface", () => {
  it("returns bare host root for messages", () => {
    expect(baseUrlForSurface("https://api.haimaker.ai", "messages")).toBe(
      "https://api.haimaker.ai"
    );
  });

  it("returns host + /v1 for chat", () => {
    expect(baseUrlForSurface("https://api.haimaker.ai", "chat")).toBe(
      "https://api.haimaker.ai/v1"
    );
  });

  it("returns host + /v1 for responses", () => {
    expect(baseUrlForSurface("https://api.haimaker.ai", "responses")).toBe(
      "https://api.haimaker.ai/v1"
    );
  });

  it("never produces /v1/v1 even if host carries a /v1", () => {
    expect(baseUrlForSurface("https://api.haimaker.ai/v1", "chat")).toBe(
      "https://api.haimaker.ai/v1"
    );
    expect(baseUrlForSurface("https://api.haimaker.ai/v1", "messages")).toBe(
      "https://api.haimaker.ai"
    );
  });
});

describe("constants", () => {
  it("exposes the canonical defaults", () => {
    expect(DEFAULT_HOST).toBe("https://api.haimaker.ai");
    expect(DEFAULT_MODEL).toBe("haimaker/auto");
    expect(KEYS_URL).toBe("https://haimaker.ai/keys");
  });
});

describe("validateHost", () => {
  it("accepts and normalizes an https host", () => {
    expect(validateHost("https://api.haimaker.ai/v1/")).toBe("https://api.haimaker.ai");
    expect(validateHost(DEFAULT_HOST)).toBe(DEFAULT_HOST);
  });

  it("rejects http:// by default (would leak the key in cleartext)", () => {
    expect(() => validateHost("http://localhost:8080")).toThrow(/cleartext|insecure/i);
  });

  it("allows http:// only with the explicit opt-in", () => {
    expect(validateHost("http://localhost:8080/v1", { allowInsecure: true })).toBe(
      "http://localhost:8080"
    );
  });

  it("rejects a missing/flag-looking value", () => {
    expect(() => validateHost("")).toThrow();
    expect(() => validateHost("--claude")).toThrow();
  });

  it("rejects a non-URL value", () => {
    expect(() => validateHost("not a url")).toThrow();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateHost("ftp://example.com")).toThrow();
  });
});

describe("haimakerModelRef", () => {
  it("keeps the default as auto", () => {
    expect(haimakerModelRef("haimaker/auto")).toEqual({ key: "auto", ref: "haimaker/auto" });
  });

  it("namespaces a concrete model so uninstall can recognize it", () => {
    expect(haimakerModelRef("openai/gpt-4o")).toEqual({
      key: "openai/gpt-4o",
      ref: "haimaker/openai/gpt-4o",
    });
  });

  it("labels keys for display", () => {
    expect(haimakerModelLabel("auto")).toBe("Haimaker Auto");
    expect(haimakerModelLabel("openai/gpt-4o")).toBe("Haimaker openai/gpt-4o");
  });
});
