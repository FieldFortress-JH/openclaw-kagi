import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { readStoredToken, writeStoredToken, clearStoredToken } from "./token-store.js";

const SETTINGS_URL = "https://kagi.com/settings/user_details";

function mask(token: string): string {
  if (token.length <= 10) return "*".repeat(token.length);
  return token.slice(0, 6) + "..." + token.slice(-4);
}

export async function handleKagiCommand(
  ctx: Pick<PluginCommandContext, "args">
): Promise<{ text: string }> {
  const args = (ctx.args ?? "").trim();
  const [subcommand, ...rest] = args.split(/\s+/);
  const value = rest.join(" ").trim();

  switch (subcommand?.toLowerCase()) {
    case "session": {
      if (!value) {
        return {
          text: `Usage: /kagi session <session-link>\n\nPaste your Session Link from ${SETTINGS_URL}`,
        };
      }
      const token = writeStoredToken(value);
      return {
        text: `✅ Kagi Session Link saved (${mask(token)}). Web search will now use Kagi.`,
      };
    }

    case "status": {
      const token = readStoredToken();
      if (!token) {
        return {
          text: `No Kagi Session Link configured.\n\nSet one with: /kagi session <session-link>\nGet yours from: ${SETTINGS_URL}`,
        };
      }
      return { text: `Kagi Session Link configured: ${mask(token)}` };
    }

    case "clear": {
      clearStoredToken();
      return { text: "Kagi Session Link removed." };
    }

    default: {
      return {
        text: [
          "Usage:",
          "  /kagi session <session-link>  — Save your Kagi Session Link",
          "  /kagi status                  — Check if a Session Link is configured",
          "  /kagi clear                   — Remove saved Session Link",
          "",
          `Get your Session Link from: ${SETTINGS_URL}`,
        ].join("\n"),
      };
    }
  }
}

export function createKagiCommands(): OpenClawPluginCommandDefinition {
  return {
    name: "kagi",
    description:
      "Manage Kagi search: /kagi session <session-link>, /kagi status, /kagi clear",
    acceptsArgs: true,
    requireAuth: true,
    handler: handleKagiCommand,
  };
}
