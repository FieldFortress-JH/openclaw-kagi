import type { KagiSearchResult } from "./types.js";
import { parseKagiResultsPage } from "../html-parser.js";
import { validateTokenFromResponse } from "../token-validator.js";

const KAGI_ORIGIN = "https://kagi.com";
const KAGI_SEARCH_URL = `${KAGI_ORIGIN}/html/search`;
const SETTINGS_URL = "https://kagi.com/settings/user_details";
const ISSUES_URL = "https://github.com/FieldFortress-JH/openclaw-kagi/issues";

export interface SessionSearchOptions {
  token: string;
  query: string;
  count: number;
  timeoutMs: number;
  /** Caller cancellation (forwarded from OpenClaw's tool execution context). */
  signal?: AbortSignal;
  /** OpenClaw request fence; called before each network request. */
  assertCurrent?: () => void;
}

export type SessionSearchResult =
  | {
      ok: true;
      results: KagiSearchResult[];
    }
  | {
      ok: false;
      error: string;
      errorCode:
        | "token_expired"
        | "token_invalid"
        | "parse_breakage"
        | "fetch_error";
      detail?: string;
      /** Debug-only page structure sample; never returned to the model. */
      htmlSample?: string;
    };

const EXPIRED_MESSAGE =
  `Kagi Session Link has expired or is invalid. Ask the user to generate a new one at ${SETTINGS_URL} and paste it, or use: /kagi session <session-link>`;

/** Resolve a redirect target, allowing only https://kagi.com so the session cookie never leaves Kagi. */
function resolveKagiRedirect(location: string): URL | undefined {
  try {
    const url = new URL(location, KAGI_ORIGIN);
    return url.origin === KAGI_ORIGIN ? url : undefined;
  } catch {
    return undefined;
  }
}

function isSigninUrl(url: string): boolean {
  try {
    const { pathname, search } = new URL(url);
    return pathname.startsWith("/signin") || search.includes("invalid_token");
  } catch {
    return false;
  }
}

export async function sessionSearch(
  opts: SessionSearchOptions
): Promise<SessionSearchResult> {
  const url = new URL(KAGI_SEARCH_URL);
  url.searchParams.set("token", opts.token);
  url.searchParams.set("q", opts.query);

  const headers: Record<string, string> = {
    "User-Agent":
      "OpenClaw-Kagi/1.1 (Plugin; +https://github.com/FieldFortress-JH/openclaw-kagi)",
    Accept: "text/html",
  };

  // One deadline for the whole exchange, also honoring caller cancellation.
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let response: Response;
  try {
    opts.assertCurrent?.();
    // Step 1: Send request with token — Kagi responds with 302 + Set-Cookie
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return {
      ok: false,
      error: `Failed to fetch Kagi search results: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "fetch_error",
    };
  }

  // Validate token from the initial response
  const tokenStatus = validateTokenFromResponse(response);
  if (!tokenStatus.valid) {
    await response.body?.cancel().catch(() => {});
    if (tokenStatus.reason === "redirect_to_login") {
      return { ok: false, error: EXPIRED_MESSAGE, errorCode: "token_expired" };
    }
    return {
      ok: false,
      error: `Kagi returned HTTP ${tokenStatus.statusCode}. The Session Link may be invalid. Ask the user for a new one from ${SETTINGS_URL} or use: /kagi session <session-link>`,
      errorCode: "token_invalid",
      detail: tokenStatus.detail,
    };
  }

  let html: string;

  if (response.status === 302) {
    // Step 2: Valid token — Kagi set a cookie and redirected.
    // Extract the Set-Cookie and follow the redirect.
    await response.body?.cancel().catch(() => {});
    const cookieHeader = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const redirectUrl = resolveKagiRedirect(response.headers.get("location") ?? "");
    if (!redirectUrl) {
      return {
        ok: false,
        error: "Kagi redirected to an unexpected location; refusing to forward the session.",
        errorCode: "fetch_error",
      };
    }

    try {
      opts.assertCurrent?.();
      // Follow further redirects manually too, so the cookie stays on kagi.com.
      let followUp = await fetch(redirectUrl, {
        method: "GET",
        headers: { ...headers, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
        redirect: "manual",
        signal,
      });
      for (let hops = 0; followUp.status >= 300 && followUp.status < 400 && hops < 3; hops++) {
        await followUp.body?.cancel().catch(() => {});
        const next = resolveKagiRedirect(followUp.headers.get("location") ?? "");
        if (!next) {
          return {
            ok: false,
            error: "Kagi redirected to an unexpected location; refusing to forward the session.",
            errorCode: "fetch_error",
          };
        }
        if (isSigninUrl(next.href)) {
          return { ok: false, error: EXPIRED_MESSAGE, errorCode: "token_expired" };
        }
        opts.assertCurrent?.();
        followUp = await fetch(next, {
          method: "GET",
          headers: { ...headers, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
          redirect: "manual",
          signal,
        });
      }

      if (!followUp.ok) {
        await followUp.body?.cancel().catch(() => {});
        return {
          ok: false,
          error: `Kagi returned HTTP ${followUp.status} on follow-up request.`,
          errorCode: "fetch_error",
        };
      }

      html = await followUp.text();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return {
        ok: false,
        error: `Failed to follow Kagi redirect: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: "fetch_error",
      };
    }
  } else {
    // Direct 200 response (already authenticated via cookies)
    try {
      html = await response.text();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return {
        ok: false,
        error: `Failed to read Kagi response: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: "fetch_error",
      };
    }
  }

  const parsed = parseKagiResultsPage(html);

  if (parsed.possibleBreakage) {
    return {
      ok: false,
      error: [
        "Kagi returned a page but no search results could be parsed.",
        "This likely means Kagi's HTML structure has changed and the plugin's selectors need updating,",
        "or the session was signed out. Try /kagi status, or set a fresh Session Link.",
        `If it persists, report it at ${ISSUES_URL}`,
      ].join("\n"),
      errorCode: "parse_breakage",
      htmlSample: parsed.htmlStructureSample,
    };
  }

  return { ok: true, results: parsed.results.slice(0, opts.count) };
}
