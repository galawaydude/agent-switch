import * as fs from "node:fs";
import * as path from "node:path";
import { mkdirPrivate } from "./fsutil.js";
import { spawn } from "node:child_process";
import { commandFor, resolveBinary, runAttached } from "./launch.js";
import { stateRoot, userHome } from "./paths.js";
import { isMac, isWindows } from "./platform.js";
import type { Provider } from "./provider.js";
import { AccountError, find, load, type Account } from "./registry.js";
import { beginLogin, RECEIPT, recover, registerLogin, removeHome } from "./homes.js";

export interface BrowserChoice {
  name: string;
  /** Program and flags; the URL is appended. Empty when `command` is used. */
  argv: string[];
  /** A raw shell command from AGENT_SWITCH_BROWSER; the URL is appended. */
  command?: string;
}

const LINUX_BROWSERS: [string, string][] = [
  ["omarchy-launch-browser", "--private"],
  ["chromium", "--incognito"],
  ["google-chrome-stable", "--incognito"],
  ["google-chrome", "--incognito"],
  ["brave", "--incognito"],
  ["brave-browser", "--incognito"],
  ["vivaldi", "--incognito"],
  ["microsoft-edge", "--inprivate"],
  ["microsoft-edge-stable", "--inprivate"],
  ["firefox", "--private-window"],
  ["librewolf", "--private-window"],
  ["zen-browser", "--private-window"],
];

const MAC_BROWSERS: [string, string][] = [
  ["Google Chrome", "--incognito"],
  ["Brave Browser", "--incognito"],
  ["Chromium", "--incognito"],
  ["Vivaldi", "--incognito"],
  ["Microsoft Edge", "--inprivate"],
  ["Firefox", "--private-window"],
  ["LibreWolf", "--private-window"],
];

function windowsBrowsers(): [string, string, string][] {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const apps: [string, string, string][] = [
    ["Chrome", "Google\\Chrome\\Application\\chrome.exe", "--incognito"],
    ["Edge", "Microsoft\\Edge\\Application\\msedge.exe", "--inprivate"],
    ["Brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe", "--incognito"],
    ["Vivaldi", "Vivaldi\\Application\\vivaldi.exe", "--incognito"],
    ["Firefox", "Mozilla Firefox\\firefox.exe", "--private-window"],
  ];
  const found: [string, string, string][] = [];
  for (const [name, rel, flag] of apps) {
    for (const root of roots) {
      const exe = path.join(root, ...rel.split("\\"));
      if (fs.existsSync(exe)) {
        found.push([name, exe, flag]);
        break;
      }
    }
  }
  return found;
}

function macApp(name: string): boolean {
  return [path.join("/Applications", `${name}.app`), path.join(userHome(), "Applications", `${name}.app`)].some((p) => fs.existsSync(p));
}

/**
 * A browser that opens the sign-in page in a private window. A normal window
 * is almost certainly signed in to the account you already have, and the
 * login would silently reuse it. AGENT_SWITCH_BROWSER overrides the guess.
 */
export function privateBrowser(): BrowserChoice | undefined {
  const override = process.env.AGENT_SWITCH_BROWSER;
  if (override) return { name: override, argv: [], command: override };
  if (isMac()) {
    for (const [app, flag] of MAC_BROWSERS) if (macApp(app)) return { name: app, argv: ["open", "-na", app, "--args", flag] };
    return undefined;
  }
  if (isWindows()) {
    const [first] = windowsBrowsers();
    return first ? { name: first[0], argv: [first[1], first[2]] } : undefined;
  }
  for (const [binary, flag] of LINUX_BROWSERS) {
    const found = resolveBinary(binary);
    if (found) return { name: binary, argv: [found, flag] };
  }
  return undefined;
}

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The launcher script $BROWSER points at: it opens its first argument privately. */
export function browserScriptText(choice: BrowserChoice, windows = isWindows()): string {
  if (windows) {
    const program = choice.command ?? choice.argv.map((a) => `"${a}"`).join(" ");
    return `@echo off\r\nstart "" ${program} "%~1"\r\n`;
  }
  const program = choice.command ?? choice.argv.map(shellQuote).join(" ");
  return `#!/bin/sh\n${program} "$1" >/dev/null 2>&1 &\n`;
}

function browserScript(choice: BrowserChoice): string {
  const dir = path.join(stateRoot(), "run");
  mkdirPrivate(dir);
  const file = path.join(dir, `browser-${process.pid}${isWindows() ? ".cmd" : ".sh"}`);
  fs.writeFileSync(file, browserScriptText(choice), { mode: 0o700 });
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

/** Runs `claude auth login`: attached to the terminal, or piped for a UI. */
export type LoginRunner = ((binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>) & {
  /** Whether the sign-in was cancelled from the other end. */
  cancelled?: () => boolean;
};

/** The stdin line a UI sends to cancel a sign-in. Signals can't do it on Windows. */
export const CANCEL_LINE = "@@agent-switch cancel";

export const terminalRunner: LoginRunner = (binary, args, env) => runAttached(binary, args, env);

export type LoginEvent = "status" | "url" | "prompt" | "output";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;

/**
 * A runner for UIs: the CLI's output is turned into events (the sign-in link
 * it prints, the moment it asks for a code), and lines arriving on our stdin
 * are passed to it, so a pasted code reaches it. SIGTERM cancels the sign-in.
 */
export function eventRunner(emit: (event: LoginEvent, detail: string) => void): LoginRunner {
  let cancelled = false;
  const runner: LoginRunner = (binary, args, env) =>
    new Promise((resolve, reject) => {
      const command = commandFor(binary, args);
      const child = spawn(command.file, command.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsVerbatimArguments: command.verbatim,
      });
      const seen = new Set<string>();
      let buffer = "";
      const scan = (chunk: Buffer) => {
        buffer += chunk.toString("utf8").replace(ANSI_PATTERN, "");
        for (const url of buffer.match(/https:\/\/\S+(?=\s)/g) ?? []) {
          if (seen.has(url)) continue;
          seen.add(url);
          emit("url", url);
        }
        if (/paste code/i.test(buffer) && !seen.has("prompt")) {
          seen.add("prompt");
          emit("prompt", "code");
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim() && !/https:\/\//.test(line)) emit("output", line.trim());
      };
      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
      const forward = (data: Buffer) => {
        if (data.toString("utf8").includes(CANCEL_LINE)) {
          cancelled = true;
          child.kill("SIGTERM");
          return;
        }
        child.stdin.write(data);
      };
      process.stdin.on("data", forward);
      const cancel = () => child.kill("SIGTERM");
      process.on("SIGTERM", cancel);
      const done = () => {
        process.stdin.off("data", forward);
        process.stdin.pause();
        process.off("SIGTERM", cancel);
      };
      child.on("error", (error) => {
        done();
        reject(error);
      });
      child.on("exit", (code) => {
        done();
        resolve(code ?? 1);
      });
    });
  runner.cancelled = () => cancelled;
  return runner;
}

export interface LoginOptions {
  log: (line: string) => void;
  runner?: LoginRunner;
}

/**
 * Sign in to another subscription. The first sign-in goes where the CLI
 * always looks (the primary home); every later one gets a home of its own.
 */
export async function addAccount(provider: Provider, label: string, options: LoginOptions): Promise<AddResult> {
  const { log } = options;
  const run = options.runner ?? terminalRunner;
  const binary = requireBinary(provider);
  const primary = provider.primaryHome();

  if (!provider.signedIn(primary)) {
    log(`Signing in to ${provider.name} in ${primary}, your main account.`);
    await run(binary, provider.loginArgs, loginEnv(provider, undefined));
    if (!provider.signedIn(primary)) throw new AccountError("The sign-in didn't finish, so no account was added.");
    const registry = load(provider);
    return { kind: "primary", accounts: [registry.accounts.find((a) => a.primary)!] };
  }

  const recovered = recover(provider);
  if (recovered.length) return { kind: "recovered", accounts: recovered };

  if (label && find(load(provider), label)) throw new AccountError(`An account is already called "${label}". Pick another name.`);

  const choice = privateBrowser();
  if (choice) {
    log(`Sign in as the account you're adding in the private window that opens (${choice.name}).`);
    log(`If a private window was already open, close it first, or ${provider.site} may reuse whoever is signed in there.`);
  } else {
    log(`No browser with a private mode was found. Open the sign-in link in a private window yourself,`);
    log(`or ${provider.site} will reuse the account you're already signed in to.`);
  }
  log(`Don't log out of ${provider.name} to do this: logging out revokes the saved sign-in.`);

  const home = beginLogin(provider, label);
  const browser = choice ? browserScript(choice) : undefined;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await run(binary, provider.loginArgs, loginEnv(provider, home, browser));
    if (run.cancelled?.()) interrupted = true;
    if (interrupted) throw new AccountError("Sign-in cancelled.");
    return { kind: "added", accounts: [registerLogin(provider, home, label)] };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (browser) fs.rmSync(browser, { force: true });
    // A registered home has lost its receipt. One that still has it was
    // cancelled or never signed in; a signed-in one is left for `recover`.
    if (fs.existsSync(path.join(home, RECEIPT)) && (interrupted || !provider.signedIn(home))) removeHome(provider, home);
  }
}

/** Sign an existing account in again, in its own home, after its login lapsed. */
export async function reauth(provider: Provider, account: Account, options: LoginOptions): Promise<void> {
  const { log } = options;
  const run = options.runner ?? terminalRunner;
  const binary = requireBinary(provider);
  if (account.primary) {
    log(`Signing ${account.label} in again in ${provider.primaryHome()}.`);
    await run(binary, provider.loginArgs, loginEnv(provider, undefined));
    return;
  }
  const who = `${account.label}${account.email ? ` (${account.email})` : ""}`;
  const choice = privateBrowser();
  if (choice) log(`Sign in as ${who} in the private window that opens.`);
  else log(`Open the sign-in link in a private window and sign in as ${who}.`);
  const browser = choice ? browserScript(choice) : undefined;
  try {
    await run(binary, provider.loginArgs, loginEnv(provider, account.home, browser));
  } finally {
    if (browser) fs.rmSync(browser, { force: true });
  }
}
