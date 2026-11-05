import * as path from "node:path";
import { readRecord, isRecord, str, writeJsonAtomic } from "./fsutil.js";
import { readCredentials } from "./credentials.js";
import { userHome } from "./paths.js";
import type { Identity, Provider } from "./provider.js";

export interface ClaudeOauth {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch; 0 when unknown. */
  expiresAt: number;
  /** When the sign-in itself lapses unless Claude Code renews it; 0 when unknown. */
  refreshExpiresAt: number;
  subscriptionType: string;
  rateLimitTier: string;
}

function primaryHome(): string {
  return path.join(userHome(), ".claude");
}

/**
 * Claude Code keeps its account file beside the config dir for the default
 * home (~/.claude.json) and inside it for any CLAUDE_CONFIG_DIR.
 */
export function accountFile(home: string): string {
  return path.resolve(home) === path.resolve(primaryHome())
    ? path.join(userHome(), ".claude.json")
    : path.join(home, ".claude.json");
}

export { credentialsFile } from "./credentials.js";

export function readOauth(home: string): ClaudeOauth | undefined {
  const login = readCredentials(home).claudeAiOauth;
  if (!isRecord(login)) return undefined;
  const expiresAt = Number(login.expiresAt);
  const refreshExpiresAt = Number(login.refreshTokenExpiresAt);
  return {
    accessToken: str(login.accessToken),
    refreshToken: str(login.refreshToken),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    refreshExpiresAt: Number.isFinite(refreshExpiresAt) ? refreshExpiresAt : 0,
    subscriptionType: str(login.subscriptionType),
    rateLimitTier: str(login.rateLimitTier),
  };
}

export function planLabel(tier: string, subscription: string): string {
  const match = /max_(\d+x)/i.exec(tier);
  if (match) return `Max ${match[1]}`;
  if (subscription) return subscription[0]!.toUpperCase() + subscription.slice(1);
  return "";
}

/** Keys copied from the primary account file so a new login keeps MCP servers, trust and onboarding. */
export const CARRIED_KEYS = ["mcpServers", "projects", "theme", "hasCompletedOnboarding", "lastOnboardingVersion", "editorMode"];

export const claude: Provider = {
  id: "claude",
  name: "Claude",
  binary: "claude",
  homeEnv: "CLAUDE_CONFIG_DIR",
  omarchyPinEnv: "OMARCHY_AGENT_CLAUDE_HOME",
  primaryHome,
  sharedDirs: ["projects", "skills", "agents", "commands", "plugins", "hooks", "themes", "output-styles", "file-history", "todos", "plans"],
  sharedFiles: ["settings.json", "CLAUDE.md", "history.jsonl", "keybindings.json"],
  credentialFiles: [".credentials.json", ".claude.json"],
  loginArgs: ["auth", "login"],
  site: "claude.ai",

  carrySettings(newHome: string): void {
    const source = readRecord(accountFile(primaryHome()));
    const file = accountFile(newHome);
    const data = readRecord(file);
    let changed = false;
    for (const key of CARRIED_KEYS) {
      if (key in source && !(key in data)) {
        data[key] = source[key];
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(file, data);
  },

  identity(home: string): Identity {
    const account = readRecord(accountFile(home)).oauthAccount;
    const oauth = readOauth(home);
    const info = isRecord(account) ? account : {};
    return {
      accountId: str(info.accountUuid),
      email: str(info.emailAddress),
      org: str(info.organizationName),
      plan: oauth ? planLabel(oauth.rateLimitTier, oauth.subscriptionType) : "",
    };
  },

  signedIn(home: string): boolean {
    const oauth = readOauth(home);
    return Boolean(oauth && (oauth.accessToken || oauth.refreshToken));
  },
};

export const PROVIDERS: Record<string, Provider> = { claude };
