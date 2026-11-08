import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createKagiWebSearchProvider,
  clearKagiSearchCache,
} from "../src/kagi-search-provider.js";
import { writeStoredToken } from "../src/token-store.js";
import { loadFixture } from "./helpers.js";

let stateDir: string;
const provider = createKagiWebSearchProvider();

function mockSearch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(loadFixture("kagi-results-normal.html"), { status: 200 })
  );
}

describe("Kagi web search provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearKagiSearchCache();
    stateDir = mkdtempSync(join(tmpdir(), "openclaw-kagi-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("asks for a Session Link when none is configured", async () => {
    const tool = provider.createTool({})!;
    const result = await tool.execute({ query: "test" });
    expect(result.error).toBe("missing_session_token");
    expect(String(result.message)).toContain("/kagi session");
  });

  it("uses the /kagi session store and wraps results as untrusted", async () => {
    writeStoredToken("https://kagi.com/search?token=STORE_TOKEN");
    const fetchSpy = mockSearch();

    const result = await provider.createTool({})!.execute({ query: "test", count: 3 });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get("token")).toBe("STORE_TOKEN");
    const results = result.results as Array<{ title: string; url: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results[0].title).not.toBe("");
    expect((result.externalContent as { untrusted: boolean }).untrusted).toBe(true);
  });

  it("falls back to the token in OpenClaw plugin config", async () => {
    const fetchSpy = mockSearch();
    const config = {
      plugins: { entries: { kagi: { config: { webSearch: { apiKey: "CFG_TOKEN" } } } } },
    };

    await provider.createTool({ config: config as never })!.execute({ query: "test" });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get("token")).toBe("CFG_TOKEN");
    expect(provider.getConfiguredCredentialValue?.(config as never)).toBe("CFG_TOKEN");
  });

  it("writes setup-wizard credentials where it reads them", () => {
    const target: Record<string, unknown> = {};
    provider.setConfiguredCredentialValue?.(target as never, "WIZ");
    expect(provider.getConfiguredCredentialValue?.(target as never)).toBe("WIZ");
  });

  it("caches repeated queries and honors cacheTtlMinutes: 0", async () => {
    writeStoredToken("TOKEN");
    const fetchSpy = mockSearch();

    const tool = provider.createTool({})!;
    await tool.execute({ query: "same" });
    const second = await tool.execute({ query: "same" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);

    const noCache = provider.createTool({ searchConfig: { cacheTtlMinutes: 0 } })!;
    await noCache.execute({ query: "other" });
    await noCache.execute({ query: "other" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
