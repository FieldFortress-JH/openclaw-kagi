import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createKagiCommands } from "../src/commands.js";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Never touch the real ~/.openclaw store: point OpenClaw state at a temp dir.
let stateDir: string;
let STORE_PATH: string;
const command = createKagiCommands();
const run = (args: string) =>
  command.handler({ args } as Parameters<typeof command.handler>[0]) as Promise<{ text: string }>;

describe("/kagi command", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "openclaw-kagi-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    STORE_PATH = join(stateDir, "kagi.config.json");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("/kagi (no args)", () => {
    it("shows usage help", async () => {
      const result = await run("");
      expect(result.text).toContain("/kagi session");
      expect(result.text).toContain("/kagi status");
      expect(result.text).toContain("/kagi clear");
    });
  });

  describe("/kagi session", () => {
    it("saves a raw token", async () => {
      const result = await run("session ABC123DEF");
      expect(result.text).toContain("✅");
      expect(result.text).not.toContain("ABC123DEF"); // short tokens are fully masked

      const stored = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
      expect(stored.sessionToken).toBe("ABC123DEF");
    });

    it("writes the store with owner-only permissions", async () => {
      writeFileSync(STORE_PATH, "{}", { mode: 0o644 });
      await run("session ABC123DEF");
      expect(statSync(STORE_PATH).mode & 0o777).toBe(0o600);
    });

    it("extracts token from a full Session Link URL", async () => {
      const result = await run("session https://kagi.com/search?token=MY_TOKEN_VALUE");
      expect(result.text).toContain("✅");

      const stored = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
      expect(stored.sessionToken).toBe("MY_TOKEN_VALUE");
    });

    it("shows usage when no value provided", async () => {
      const result = await run("token");
      expect(result.text).toContain("Usage");
      expect(result.text).toContain("session-link");
    });
  });

  describe("/kagi status", () => {
    it("shows 'not configured' when no token", async () => {
      const result = await run("status");
      expect(result.text).toContain("No Kagi Session Link configured");
      expect(result.text).toContain("/kagi session");
    });

    it("shows masked token when configured", async () => {
      writeFileSync(
        STORE_PATH,
        JSON.stringify({ sessionToken: "ABCDEF123456" }),
      );
      const result = await run("status");
      expect(result.text).toContain("ABCDEF...3456");
    });
  });

  describe("/kagi clear", () => {
    it("removes the stored token", async () => {
      writeFileSync(
        STORE_PATH,
        JSON.stringify({ sessionToken: "ABCDEF123456" }),
      );
      const result = await run("clear");
      expect(result.text).toContain("removed");

      expect(() => readFileSync(STORE_PATH, "utf-8")).toThrow();
      expect((await run("status")).text).toContain("No Kagi Session Link");
    });

    it("works even when no token exists", async () => {
      const result = await run("clear");
      expect(result.text).toContain("removed");
    });
  });

  describe("unknown subcommand", () => {
    it("shows usage", async () => {
      const result = await run("foo");
      expect(result.text).toContain("Usage");
    });
  });
});
