import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { isWindows } from "./platform.js";
import type { Provider } from "./provider.js";
import type { Account } from "./registry.js";

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (isWindows()) return true; // Windows runs by extension, not mode bits
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

function extensions(name: string): string[] {
  if (!isWindows() || path.extname(name)) return [""];
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...pathext.map((e) => e.toLowerCase()), ""];
}

/**
 * The first `name` on PATH that isn't agent-switch itself, so a `claude`
 * shim pointing back at us can never recurse.
 */
export function resolveBinary(name: string, envPath = process.env.PATH ?? process.env.Path ?? ""): string | undefined {
  if (process.env.AGENT_SWITCH_CLAUDE_BIN && name === "claude") return process.env.AGENT_SWITCH_CLAUDE_BIN;
  const delimiter = isWindows() ? ";" : path.delimiter;
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions(name)) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate) && realpath(candidate) !== SELF) return candidate;
    }
  }
  return undefined;
}

/**
 * How to start a resolved binary. Windows batch files (npm's `claude.cmd`
 * shims) can't be spawned directly, and going through cmd.exe re-parses the
 * arguments. When the shim belongs to an npm package, run its script with
 * Node instead; otherwise fall back to cmd.exe with careful quoting.
 */
export function commandFor(file: string, args: readonly string[]): { file: string; args: string[]; verbatim: boolean } {
  if (!isWindows() || !/\.(cmd|bat)$/i.test(file)) return { file, args: [...args], verbatim: false };
  const script = npmShimTarget(file);
  if (script) return { file: process.execPath, args: [script, ...args], verbatim: false };
  const line = [`"${file}"`, ...args.map(quoteForCmd)].join(" ");
  return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** The JS entry an npm `.cmd` shim runs: the `%dp0%\\...js` path inside it. */
export function npmShimTarget(shim: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  // "%dp0%\\node_modules\\...\\cli.js" (current npm) or "%~dp0\\..." (older)
  const match = /"%~?dp0%?\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  if (!match) return undefined;
  const script = path.join(path.dirname(shim), ...match[1]!.split("\\"));
  return fs.existsSync(script) ? script : undefined;
}

/** Quote one argument for cmd.exe /s /c (the cross-spawn rules). */
export function quoteForCmd(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(/[()%!^"<>&|]/g, "^$&");
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
export function runAttached(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { fromTerminal?: boolean } = {},
): Promise<number> {
  // Without a terminal (an editor starting us), nothing sends Ctrl+C to the
  // child for us, so every signal has to be passed on.
  const fromTerminal = options.fromTerminal ?? true;
  return new Promise((resolve, reject) => {
    const command = commandFor(file, args);
    const child = spawn(command.file, command.args, { stdio: "inherit", env, windowsVerbatimArguments: command.verbatim });
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of fromTerminal ? FORWARDED : [...FORWARDED, ...GROUP_DELIVERED]) {
      handlers.set(signal, () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      });
    }
    if (fromTerminal) for (const signal of GROUP_DELIVERED) handlers.set(signal, () => undefined);
    const listening: [NodeJS.Signals, () => void][] = [];
    for (const [signal, handler] of handlers) {
      try {
        process.on(signal, handler);
        listening.push([signal, handler]);
      } catch {
        // not a signal this platform has
      }
    }
    const cleanup = () => {
      for (const [signal, handler] of listening) process.off(signal, handler);
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
