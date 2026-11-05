import * as fs from "node:fs";
import * as path from "node:path";
import { mkdirPrivate } from "./fsutil.js";
import { resolveBinary, runAttached } from "./launch.js";
import { stateRoot } from "./paths.js";
import type { Provider } from "./provider.js";
import { AccountError, find, load, type Account } from "./registry.js";
import { beginLogin, recover, registerLogin } from "./homes.js";

interface BrowserChoice {
  name: string;
  /** Shell words; the URL is appended as "$1". */
  command: string;
}

const PRIVATE_BROWSERS: { binary: string; flag: string }[] = [
  { binary: "omarchy-launch-browser", flag: "--private" },
  { binary: "chromium", flag: "--incognito" },
  { binary: "google-chrome-stable", flag: "--incognito" },
  { binary: "google-chrome", flag: "--incognito" },
  { binary: "brave", flag: "--incognito" },
  { binary: "brave-browser", flag: "--incognito" },
  { binary: "vivaldi", flag: "--incognito" },
  { binary: "microsoft-edge", flag: "--inprivate" },
  { binary: "microsoft-edge-stable", flag: "--inprivate" },
  { binary: "firefox", flag: "--private-window" },
  { binary: "librewolf", flag: "--private-window" },
  { binary: "zen-browser", flag: "--private-window" },
];

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * A browser that opens the sign-in page in a private window. A normal window
 * is almost certainly signed in to the account you already have, and the
 * login would silently reuse it. AGENT_SWITCH_BROWSER overrides the guess.
 */
export function privateBrowser(): BrowserChoice | undefined {
  const override = process.env.AGENT_SWITCH_BROWSER;
  if (override) return { name: override, command: override };
  for (const { binary, flag } of PRIVATE_BROWSERS) {
    const found = resolveBinary(binary);
    if (found) return { name: binary, command: `${shellQuote(found)} ${flag}` };
  }
  return undefined;
}

/** Write a one-line launcher that $BROWSER can point at. */
function browserScript(choice: BrowserChoice): string {
  const dir = path.join(stateRoot(), "run");
  mkdirPrivate(dir);
  const file = path.join(dir, `browser-${process.pid}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\nexec ${choice.command} "$1" >/dev/null 2>&1 &\n`, { mode: 0o700 });
  return file;
}

function loginEnv(provider: Provider, home: string | undefined, browser?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (home) {
    env[provider.homeEnv] = home;
    env[provider.omarchyPinEnv] = home;
  } else {
    delete env[provider.homeEnv];
    env[provider.omarchyPinEnv] = "";
  }
  if (browser) env.BROWSER = browser;
  return env;
}

function requireBinary(provider: Provider): string {
  const binary = resolveBinary(provider.binary);
  if (!binary) {
    throw new AccountError(`${provider.name} Code's \`${provider.binary}\` command isn't on your PATH. Install it first.`);
  }
  return binary;
}

export interface AddResult {
  kind: "primary" | "added" | "recovered";
  accounts: Account[];
}

/**
 * Sign in to another subscription. The first sign-in goes where the CLI
 * always looks (the primary home); every later one gets a home of its own.
 */
export async function addAccount(provider: Provider, label: string, log: (line: string) => void): Promise<AddResult> {
  const binary = requireBinary(provider);
  const primary = provider.primaryHome();

  if (!provider.signedIn(primary)) {
    log(`Signing in to ${provider.name} in ${primary}, your main account.`);
    await runAttached(binary, provider.loginArgs, loginEnv(provider, undefined));
    if (!provider.signedIn(primary)) throw new AccountError("The sign-in didn't finish, so no account was added.");
    const registry = load(provider);
    return { kind: "primary", accounts: [registry.accounts.find((a) => a.primary)!] };
  }

  const recovered = recover(provider);
  if (recovered.length) return { kind: "recovered", accounts: recovered };

  if (label && find(load(provider), label)) throw new AccountError(`An account is already called "${label}". Pick another name.`);

  const choice = privateBrowser();
  log("");
  if (choice) {
    log(`Sign in as the account you're adding in the private window that opens (${choice.name}).`);
    log(`If a private window was already open, close it first, or ${provider.site} may reuse whoever is signed in there.`);
  } else {
    log(`No browser with a private mode was found. When ${provider.name} prints a sign-in link,`);
    log(`open it in a private window yourself, or ${provider.site} will reuse the account you're already signed in to.`);
    log("Set AGENT_SWITCH_BROWSER to a command that opens a URL privately to skip this step.");
  }
  log(`Don't log out of ${provider.name} to do this: logging out revokes the saved sign-in.`);
  log("");

  const home = beginLogin(provider, label);
  const browser = choice ? browserScript(choice) : undefined;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  try {
    await runAttached(binary, provider.loginArgs, loginEnv(provider, home, browser));
    if (interrupted) throw new AccountError("Sign-in cancelled.");
    return { kind: "added", accounts: [registerLogin(provider, home, label)] };
  } finally {
    process.off("SIGINT", onSignal);
    if (browser) fs.rmSync(browser, { force: true });
    // registerLogin moves or removes the home; anything left was abandoned.
    if (fs.existsSync(home) && (interrupted || !provider.signedIn(home))) fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Sign an existing account in again, in its own home, after its login lapsed. */
export async function reauth(provider: Provider, account: Account, log: (line: string) => void): Promise<void> {
  const binary = requireBinary(provider);
  if (account.primary) {
    log(`Signing ${account.label} in again in ${provider.primaryHome()}.`);
    await runAttached(binary, provider.loginArgs, loginEnv(provider, undefined));
    return;
  }
  const choice = privateBrowser();
  if (choice) log(`Sign in as ${account.label}${account.email ? ` (${account.email})` : ""} in the private window that opens.`);
  else log(`Open the sign-in link in a private window and sign in as ${account.label}${account.email ? ` (${account.email})` : ""}.`);
  const browser = choice ? browserScript(choice) : undefined;
  try {
    await runAttached(binary, provider.loginArgs, loginEnv(provider, account.home, browser));
  } finally {
    if (browser) fs.rmSync(browser, { force: true });
  }
}
