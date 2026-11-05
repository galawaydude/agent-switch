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

/**
 * Signals sent to the wrapper alone (kill, a closing session manager) are
 * passed on. Terminal-generated ones (Ctrl+C, Ctrl+Backslash, resizes) already reach
 * the whole foreground process group, child included: forwarding those would
 * deliver them twice, and Claude Code reads a double Ctrl+C as "exit". The
 * wrapper just ignores them and waits for the child to decide.
 */
const FORWARDED: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGUSR1", "SIGUSR2"];
const GROUP_DELIVERED: NodeJS.Signals[] = ["SIGINT", "SIGQUIT", "SIGWINCH"];

/**
 * Run a child with the terminal, and resolve with the exit code a shell
 * would report (128 + signal number for a signal death).
 */
export function runAttached(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED) {
      handlers.set(signal, () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      });
    }
    for (const signal of GROUP_DELIVERED) handlers.set(signal, () => undefined);
    for (const [signal, handler] of handlers) process.on(signal, handler);
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
