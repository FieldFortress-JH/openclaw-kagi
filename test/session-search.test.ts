import { describe, it, expect, vi, beforeEach } from "vitest";
import { sessionSearch } from "../src/search/session-search.js";
import { loadFixture } from "./helpers.js";

/** Simulate Kagi's valid-token 302 → cookie → 200 flow */
function mockValidTokenFlow(html: string) {
  let callCount = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      return new Response("", {
        status: 302,
        headers: {
          Location: "/html/search?q=test",
          "Set-Cookie": "kagi_session=TOKEN123; path=/; Secure; HttpOnly",
        },
      });
    }
    return new Response(html, { status: 200 });
  });
}

describe("sessionSearch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handles two-step cookie auth flow (302 → 200)", async () => {
    const html = loadFixture("kagi-results-normal.html");
    const fetchSpy = mockValidTokenFlow(html);

    const result = await sessionSearch({
      token: "test-token",
      query: "openai gpt 5",
      count: 5,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThanOrEqual(5);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("passes cookie from 302 response to follow-up request", async () => {
    const html = loadFixture("kagi-results-normal.html");
    const fetchSpy = mockValidTokenFlow(html);

    await sessionSearch({
      token: "test-token",
      query: "test",
      count: 5,
      timeoutMs: 10000,
    });

    const secondCallOpts = fetchSpy.mock.calls[1][1] as RequestInit;
    const cookieHeader = (secondCallOpts.headers as Record<string, string>)
      ?.Cookie;
    expect(cookieHeader).toContain("kagi_session=TOKEN123");
  });

  it("handles direct 200 response (already authenticated)", async () => {
    const html = loadFixture("kagi-results-normal.html");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { status: 200 })
    );

    const result = await sessionSearch({
      token: "test-token",
      query: "openai gpt 5",
      count: 5,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeGreaterThan(0);
    }
  });

  it("trims results to requested count", async () => {
    const html = loadFixture("kagi-results-normal.html");
    mockValidTokenFlow(html);

    const result = await sessionSearch({
      token: "test-token",
      query: "openai gpt 5",
      count: 2,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeLessThanOrEqual(2);
    }
  });

  it("returns error for expired token (302 to signin)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", {
        status: 302,
        headers: { Location: "https://kagi.com/signin?p=invalid_token" },
      })
    );

    const result = await sessionSearch({
      token: "expired-token",
      query: "test",
      count: 5,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("token_expired");
      expect(result.error).toContain("expired");
    }
  });

  it("returns error for HTTP error status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 403, statusText: "Forbidden" })
    );

    const result = await sessionSearch({
      token: "bad-token",
      query: "test",
      count: 5,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("token_invalid");
    }
  });

  it("returns breakage error when parser fails on content-rich page", async () => {
    const html = loadFixture("kagi-results-mutated.html");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { status: 200 })
    );

    const result = await sessionSearch({
      token: "valid-token",
      query: "test",
      count: 5,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("parse_breakage");
      expect(result.htmlSample).toBeTruthy();
    }
  });

  it("handles fetch timeout/error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("The operation was aborted")
    );

    const result = await sessionSearch({
      token: "valid-token",
      query: "test",
      count: 5,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("fetch_error");
      expect(result.error).toContain("aborted");
    }
  });

  it("constructs correct URL with token and query", async () => {
    const html = loadFixture("kagi-results-normal.html");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { status: 200 })
    );

    await sessionSearch({
      token: "my-token-123",
      query: "hello world",
      count: 5,
      timeoutMs: 10000,
    });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(calledUrl.origin).toBe("https://kagi.com");
    expect(calledUrl.pathname).toBe("/html/search");
    expect(calledUrl.searchParams.get("token")).toBe("my-token-123");
    expect(calledUrl.searchParams.get("q")).toBe("hello world");
  });

  it("refuses to forward the session cookie to a non-Kagi redirect", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", {
        status: 302,
        headers: {
          Location: "https://evil.example.com/steal",
          "Set-Cookie": "kagi_session=TOKEN123; path=/",
        },
      })
    );

    const result = await sessionSearch({ token: "t", query: "q", count: 5, timeoutMs: 10000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("fetch_error");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports expiry when the follow-up redirects to signin", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response("", {
          status: 302,
          headers: { Location: "/html/search?q=q", "Set-Cookie": "kagi_session=X; path=/" },
        });
      }
      return new Response("", { status: 302, headers: { Location: "/signin" } });
    });

    const result = await sessionSearch({ token: "t", query: "q", count: 5, timeoutMs: 10000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("token_expired");
  });

  it("does not put the HTML sample in the model-facing error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(loadFixture("kagi-results-mutated.html"), { status: 200 })
    );

    const result = await sessionSearch({ token: "t", query: "q", count: 5, timeoutMs: 10000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("<");
  });

  it("propagates caller cancellation instead of reporting a fetch error", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(
      sessionSearch({ token: "t", query: "q", count: 5, timeoutMs: 10000, signal: controller.signal })
    ).rejects.toThrow();
  });
});
