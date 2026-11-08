import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import { wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import { sessionSearch } from "./search/session-search.js";
import { readStoredToken } from "./token-store.js";
import { extractToken } from "./token-validator.js";

type WebSearchProviderPlugin = Parameters<OpenClawPluginApi["registerWebSearchProvider"]>[0];
type OpenClawConfig = NonNullable<Parameters<NonNullable<WebSearchProviderPlugin["getConfiguredCredentialValue"]>>[0]>;

const PROVIDER_ID = "kagi";
const CREDENTIAL_PATH = `plugins.entries.${PROVIDER_ID}.config.webSearch.apiKey`;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_CACHE_TTL_MINUTES = 15;
const MAX_CACHE_ENTRIES = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asRecord(target[key]);
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  target[key] = created;
  return created;
}

function asToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? extractToken(value) : undefined;
}

/** Session Link set through OpenClaw config (setup wizard / `openclaw config`). */
function readConfigToken(config?: OpenClawConfig): string | undefined {
  const entries = asRecord(asRecord(asRecord(config)?.plugins)?.entries);
  const webSearch = asRecord(asRecord(asRecord(entries?.[PROVIDER_ID])?.config)?.webSearch);
  return asToken(webSearch?.apiKey);
}

/** `/kagi session` store wins; OpenClaw config is the fallback. */
function resolveToken(config?: OpenClawConfig, searchConfig?: Record<string, unknown>): string | undefined {
  return (
    readStoredToken() ??
    readConfigToken(config) ??
    asToken(asRecord(searchConfig?.[PROVIDER_ID])?.apiKey)
  );
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveCacheTtlMs(searchConfig?: Record<string, unknown>): number {
  const minutes = searchConfig?.cacheTtlMinutes;
  const value =
    typeof minutes === "number" && Number.isFinite(minutes)
      ? Math.max(0, minutes)
      : DEFAULT_CACHE_TTL_MINUTES;
  return Math.round(value * 60_000);
}

function siteName(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

// Plugin-local result cache (the host's cache helpers are not a public SDK surface).
const cache = new Map<string, { expiresAt: number; payload: Record<string, unknown> }>();

function readCache(key: string): Record<string, unknown> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return { ...entry.payload, cached: true };
}

function writeCache(key: string, payload: Record<string, unknown>, ttlMs: number): void {
  if (ttlMs <= 0) return;
  cache.set(key, { expiresAt: Date.now() + ttlMs, payload });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test hook. */
export function clearKagiSearchCache(): void {
  cache.clear();
}

export function createKagiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Kagi Search",
    hint: "Privacy-first search via your Kagi subscription (Session Link)",

    credentialLabel: "Kagi Session Link",
    credentialNote:
      "Paste the Session Link from https://kagi.com/settings/user_details. It grants full access to your Kagi account.",
    envVars: [],
    placeholder: "https://kagi.com/search?token=...",
    signupUrl: "https://kagi.com/settings/user_details",
    docsUrl: "https://github.com/FieldFortress-JH/openclaw-kagi#readme",
    autoDetectOrder: 50,
    credentialPath: CREDENTIAL_PATH,

    getCredentialValue: (searchConfig) => asRecord(searchConfig?.[PROVIDER_ID])?.apiKey,
    setCredentialValue: (target, value) => {
      ensureRecord(target, PROVIDER_ID).apiKey = value;
    },
    getConfiguredCredentialValue: (config) => resolveToken(config),
    setConfiguredCredentialValue: (target, value) => {
      const root = target as unknown as Record<string, unknown>;
      const plugin = ensureRecord(ensureRecord(ensureRecord(root, "plugins"), "entries"), PROVIDER_ID);
      ensureRecord(ensureRecord(plugin, "config"), "webSearch").apiKey = value;
    },

    createTool: (ctx) => ({
      description:
        "Search the web using Kagi, a privacy-first search engine. " +
        "Returns structured results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
          count: {
            type: "number",
            description: `Number of results to return (1-${MAX_COUNT}, default ${DEFAULT_COUNT})`,
            minimum: 1,
            maximum: MAX_COUNT,
          },
        },
        required: ["query"],
        additionalProperties: false,
      } as WebSearchProviderToolParameters,

      execute: async (args, execCtx) => {
        const query = readStringParam(args, "query", { required: true });
        if (!query) {
          return { error: "missing_query", message: "A search query is required." };
        }

        const count = clampInt(
          readNumberParam(args, "count", { integer: true }),
          DEFAULT_COUNT,
          1,
          MAX_COUNT
        );
        const timeoutMs =
          clampInt(ctx.searchConfig?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 1, 300) * 1000;
        const cacheTtlMs = resolveCacheTtlMs(ctx.searchConfig);

        const token = resolveToken(ctx.config, ctx.searchConfig);
        if (!token) {
          return {
            error: "missing_session_token",
            action: "ask_user_for_token",
            message: [
              "Kagi Session Link not configured.",
              "",
              "Ask the user to run: /kagi session <session-link>",
              "(Get it from: https://kagi.com/settings/user_details)",
              "",
              "Then retry the search.",
            ].join("\n"),
          };
        }

        const cacheKey = JSON.stringify([query.trim().toLowerCase(), count]);
        const cached = readCache(cacheKey);
        if (cached) return cached;

        const start = Date.now();
        const result = await sessionSearch({
          token,
          query,
          count,
          timeoutMs,
          signal: execCtx?.signal,
          assertCurrent: execCtx?.assertCurrent,
        });

        if (!result.ok) {
          return {
            error: result.errorCode,
            message: result.error,
            ...(result.detail ? { detail: result.detail } : {}),
          };
        }

        const payload = {
          query,
          provider: PROVIDER_ID,
          count: result.results.length,
          tookMs: Date.now() - start,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: PROVIDER_ID,
            wrapped: true,
          },
          results: result.results.map((r) => ({
            title: wrapWebContent(r.title, "web_search"),
            url: r.url,
            description: wrapWebContent(r.snippet, "web_search"),
            published: r.published,
            siteName: r.siteName ?? siteName(r.url),
          })),
        };

        writeCache(cacheKey, payload, cacheTtlMs);
        return payload;
      },
    }),
  };
}

type WebSearchProviderToolParameters = NonNullable<
  ReturnType<WebSearchProviderPlugin["createTool"]>
>["parameters"];
