import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import type { Provider } from "./provider.js";
import type { Account } from "./registry.js";

function isExecutable(file: string): boolean {
  try {
    const info = fs.statSync(file);
    if (!info.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

const SELF = realpath(fileURLToPath(new URL("./cli.js", import.meta.url)));

/**
 * The first `name` on PATH that isn't agent-switch itself, so a `claude`
 * symlink pointing back at us can never recurse.
 */
export function resolveBinary(name: string, envPath = process.env.PATH ?? ""): string | undefined {
  if (process.env.AGENT_SWITCH_CLAUDE_BIN && name === "claude") return process.env.AGENT_SWITCH_CLAUDE_BIN;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate) && realpath(candidate) !== SELF) return candidate;
  }
  return undefined;
}

/**
 * The environment a session for `account` runs in. The primary account
 * leaves the home variable unset: Claude Code's implicit default is also what
 * selects ~/.claude.json. Omarchy's wrapper is pinned to the same choice.
 */
export function accountEnv(provider: Provider, account: Account, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (account.primary) {
    delete env[provider.homeEnv];
    env[provider.omarchyPinEnv] = "";
  } else {
    env[provider.homeEnv] = account.home;
    env[provider.omarchyPinEnv] = account.home;
  }
  env.AGENT_SWITCH_ACCOUNT = account.id;
  return env;
}

const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGWINCH", "SIGUSR1", "SIGUSR2"];

/**
 * Run a child with the terminal, forward signals to it, and resolve with the
 * exit code a shell would report (128 + signal number for a signal death).
 */
export function runAttached(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED) {
      // The terminal already delivers Ctrl+C to the whole foreground group;
      // forwarding again is harmless for Claude Code and needed for kill(1).
      const handler = () => {
        if (child.exitCode === null) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (signal) {
        const number = (constants.signals as Record<string, number>)[signal] ?? 1;
        resolve(128 + number);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}
