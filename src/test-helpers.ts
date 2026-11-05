import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Point HOME and the state dir at a fresh temporary directory, so tests never
 * touch a real ~/.claude. Returns the fake home.
 */
export function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asw-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  process.env.AGENT_SWITCH_STATE_DIR = path.join(root, "state");
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
  delete process.env.CLAUDE_CONFIG_DIR;
  return home;
}

export interface FakeLogin {
  accountId: string;
  email: string;
  org?: string;
  tier?: string;
  subscription?: string;
  accessToken?: string;
  expiresAt?: number;
}

/** Write the files `claude auth login` leaves behind into a config home. */
export function fakeLogin(configHome: string, login: FakeLogin): void {
  fs.mkdirSync(configHome, { recursive: true });
  const home = process.env.HOME!;
  const isPrimary = path.resolve(configHome) === path.join(home, ".claude");
  const accountFile = isPrimary ? path.join(home, ".claude.json") : path.join(configHome, ".claude.json");
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(accountFile, "utf8"));
  } catch {
    // new file
  }
  data.oauthAccount = { accountUuid: login.accountId, emailAddress: login.email, organizationName: login.org ?? "" };
  fs.writeFileSync(accountFile, JSON.stringify(data));
  fs.writeFileSync(
    path.join(configHome, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: login.accessToken ?? `access-${login.accountId}`,
        refreshToken: `refresh-${login.accountId}`,
        expiresAt: login.expiresAt ?? Date.now() + 3_600_000,
        subscriptionType: login.subscription ?? "max",
        rateLimitTier: login.tier ?? "default_claude_max_5x",
      },
    }),
    { mode: 0o600 },
  );
}
