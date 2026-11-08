import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { extractToken } from "./token-validator.js";

const STORE_FILE = "kagi.config.json";

interface KagiConfig {
  sessionToken?: string;
}

/**
 * Path of the Session Link store. Resolved per call so it follows
 * OPENCLAW_STATE_DIR (default ~/.openclaw), like the rest of OpenClaw state.
 */
export function resolveStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateDir(env), STORE_FILE);
}

export function readStoredToken(): string | undefined {
  try {
    const data: KagiConfig = JSON.parse(readFileSync(resolveStorePath(), "utf-8"));
    return typeof data.sessionToken === "string" && data.sessionToken
      ? data.sessionToken
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save a Session Link (or raw token). The file holds a full-account Kagi
 * credential, so it is written atomically with owner-only permissions.
 */
export function writeStoredToken(tokenOrUrl: string): string {
  const token = extractToken(tokenOrUrl);
  if (!token) throw new Error("Empty Kagi Session Link");

  const path = resolveStorePath();
  mkdirSync(resolveStateDir(), { recursive: true, mode: 0o700 });

  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ sessionToken: token } satisfies KagiConfig, null, 2) + "\n",
    { encoding: "utf-8", mode: 0o600 }
  );
  renameSync(tmp, path);
  // Tighten files created by older versions with default (world-readable) mode.
  chmodSync(path, 0o600);
  return token;
}

export function clearStoredToken(): void {
  try {
    unlinkSync(resolveStorePath());
  } catch {
    // ignore if file doesn't exist
  }
}
