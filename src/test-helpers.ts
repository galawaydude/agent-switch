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
  delete process.env.AGENT_SWITCH_PLATFORM;
  delete process.env.AGENT_SWITCH_SECURITY_BIN;
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

/**
 * A stand-in for macOS's `security` command backed by a JSON file, so the
 * Keychain path can be tested anywhere. Returns the store file.
 */
export function fakeKeychain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asw-kc-"));
  const store = path.join(dir, "store.json");
  fs.writeFileSync(store, "{}");
  const script = path.join(dir, "security.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
const store = ${JSON.stringify(store)};
const [cmd, ...rest] = process.argv.slice(2);
const opt = (f) => { const i = rest.indexOf(f); return i === -1 ? undefined : rest[i + 1]; };
const data = JSON.parse(fs.readFileSync(store, "utf8"));
const key = opt("-a") + "|" + opt("-s");
if (cmd === "find-generic-password") {
  if (!(key in data)) process.exit(44);
  if (rest.includes("-w")) process.stdout.write(data[key] + "\\n");
  process.exit(0);
}
if (cmd === "delete-generic-password") {
  if (!(key in data)) process.exit(44);
  delete data[key];
  fs.writeFileSync(store, JSON.stringify(data));
  process.exit(0);
}
process.exit(1);
`,
  );
  const launcher = path.join(dir, process.platform === "win32" ? "security.cmd" : "security");
  fs.writeFileSync(
    launcher,
    process.platform === "win32" ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  process.env.AGENT_SWITCH_SECURITY_BIN = launcher;
  return store;
}

/** Put a login into the fake Keychain the way Claude Code would. */
export function keychainLogin(store: string, account: string, service: string, login: FakeLogin): void {
  const data = JSON.parse(fs.readFileSync(store, "utf8"));
  data[`${account}|${service}`] = JSON.stringify({
    claudeAiOauth: {
      accessToken: login.accessToken ?? `access-${login.accountId}`,
      refreshToken: `refresh-${login.accountId}`,
      expiresAt: login.expiresAt ?? Date.now() + 3_600_000,
      subscriptionType: login.subscription ?? "max",
      rateLimitTier: login.tier ?? "default_claude_max_5x",
    },
  });
  fs.writeFileSync(store, JSON.stringify(data));
}

/** Write only the account file (identity) a login leaves, without credentials. */
export function fakeAccountFile(configHome: string, login: FakeLogin): void {
  fs.mkdirSync(configHome, { recursive: true });
  const home = process.env.HOME!;
  const isPrimary = path.resolve(configHome) === path.join(home, ".claude");
  const file = isPrimary ? path.join(home, ".claude.json") : path.join(configHome, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: login.accountId, emailAddress: login.email, organizationName: login.org ?? "" } }));
}
