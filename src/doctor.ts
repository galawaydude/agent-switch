import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { credentialsFile, readOauth } from "./claude.js";
import { readRecord } from "./fsutil.js";
import { resolveBinary } from "./launch.js";
import { stateRoot, userHome } from "./paths.js";
import type { Provider } from "./provider.js";
import { accountHome, load } from "./registry.js";

export type Level = "ok" | "warn" | "fail";

export interface Finding {
  level: Level;
  message: string;
  fix?: string;
}

function lstat(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function shellFunctionInstalled(): string | undefined {
  const home = userHome();
  const files = [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".config/fish/config.fish"].map((f) => path.join(home, f));
  for (const file of files) {
    try {
      if (fs.readFileSync(file, "utf8").includes("agent-switch shell-init")) return file;
    } catch {
      // not there
    }
  }
  return undefined;
}

/** Everything that can quietly go wrong, checked in one place. */
export function diagnose(provider: Provider, now = Date.now()): Finding[] {
  const findings: Finding[] = [];
  const add = (level: Level, message: string, fix?: string) => findings.push({ level, message, fix });

  // Platform
  if (process.platform === "linux") add("ok", "Linux: Claude Code keeps logins in files agent-switch can manage.");
  else if (process.platform === "darwin") {
    add("fail", "macOS keeps Claude Code's login in the Keychain, which agent-switch doesn't manage yet.", "Track macOS support in the project's issues.");
  } else add("warn", `${process.platform} is untested.`);

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) add("fail", `Node ${process.versions.node} is too old.`, "Install Node 20 or newer.");

  // Claude Code
  const binary = resolveBinary(provider.binary);
  if (!binary) add("fail", `\`${provider.binary}\` isn't on your PATH.`, "Install Claude Code: https://docs.claude.com/claude-code");
  else {
    const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, AGENT_SWITCH_NO_CHECK: "1" } });
    add("ok", `Claude Code ${(version.stdout || "").trim() || "(version unknown)"} at ${binary}`);
  }

  // Shell integration
  const rc = shellFunctionInstalled();
  if (rc) add("ok", `The claude shell function is set up in ${rc.replace(userHome(), "~")}.`);
  else {
    add(
      "warn",
      "Typing `claude` won't use agent-switch yet; only `agent-switch run` will.",
      'Add this to your shell rc: eval "$(agent-switch shell-init)"',
    );
  }

  if (process.env[provider.homeEnv] && !process.env.AGENT_SWITCH_ACCOUNT) {
    add(
      "warn",
      `${provider.homeEnv} is set in your environment (${process.env[provider.homeEnv]}), so every launch uses it and ignores your choice.`,
      `Unset ${provider.homeEnv} in your shell config.`,
    );
  }

  // State
  const root = stateRoot();
  const info = lstat(root);
  if (info && (info.mode & 0o077) !== 0) add("warn", `${root} is readable by other users.`, `chmod 700 ${root}`);

  // Accounts
  const registry = load(provider);
  for (const account of registry.accounts) {
    const home = accountHome(provider, account);
    const name = `${account.label}${account.email ? ` (${account.email})` : ""}`;
    if (!fs.existsSync(home)) {
      add("fail", `${name}: its home ${home} is gone.`, `agent-switch remove ${account.id}, then add it again.`);
      continue;
    }
    if (!provider.signedIn(home)) {
      add("fail", `${name}: not signed in.`, `agent-switch login ${account.id}`);
      continue;
    }
    const signedInAs = provider.identity(home);
    if (account.accountId && signedInAs.accountId && signedInAs.accountId !== account.accountId) {
      add("warn", `${name}: its home is now signed in as ${signedInAs.email || signedInAs.accountId}.`, "Run agent-switch list to refresh, or sign it in again.");
    }
    const creds = credentialsFile(home);
    if (lstat(creds)?.isSymbolicLink()) {
      add("fail", `${name}: its login file is a link, so it shares a login with another home.`, `Remove ${creds} and run agent-switch login ${account.id}`);
    }
    const oauth = readOauth(home);
    const refreshExpires = oauth?.refreshExpiresAt ?? 0;
    if (refreshExpires > 0 && refreshExpires < now) {
      add("fail", `${name}: its sign-in has expired.`, `agent-switch login ${account.id}`);
    } else if (refreshExpires > 0 && refreshExpires - now < 3 * 86_400_000) {
      add("warn", `${name}: its sign-in expires within three days unless Claude runs as it.`, `agent-switch run --as ${account.id}`);
    } else if (oauth) {
      add("ok", `${name}: signed in${account.id === registry.active ? ", active" : ""}.`);
    }
    if (!account.primary) {
      const missing = [...provider.sharedDirs, ...provider.sharedFiles].filter((n) => !lstat(path.join(home, n)));
      if (missing.length) add("warn", `${name}: not sharing ${missing.join(", ")} with your main setup.`, "agent-switch repair");
    }
  }

  // Omarchy
  const omarchyRegistry = path.join(process.env.XDG_STATE_HOME || path.join(userHome(), ".local", "state"), "omarchy", "agents", "accounts", `${provider.id}.json`);
  if (fs.existsSync(omarchyRegistry)) {
    const omarchyActive = String(readRecord(omarchyRegistry).active || "main");
    add(
      "ok",
      `Omarchy's agent accounts are here too (its active ${provider.name} account: ${omarchyActive}). Launches through agent-switch use agent-switch's choice.`,
    );
  }
  return findings;
}
