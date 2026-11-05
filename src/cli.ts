#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { PROVIDERS, claude } from "./claude.js";
import { diagnose } from "./doctor.js";
import { age, duration, meter, style, table } from "./format.js";
import { adopt, importOmarchy, remove, repairLinks } from "./homes.js";
import { accountEnv, resolveBinary, runAttached } from "./launch.js";
import { addAccount, eventRunner, reauth } from "./login.js";
import { startUi } from "./ui.js";
import { isWindows } from "./platform.js";
import { peak } from "./policy.js";
import { checkAndApply, desktopNotify, launchTarget } from "./session.js";
import { collectAll, type AccountUsage } from "./usage.js";
import type { Provider } from "./provider.js";
import {
  AccountError,
  find,
  load,
  mustFind,
  mutate,
  refreshIdentities,
  rename,
  setMode,
  use,
  type Account,
  type Registry,
} from "./registry.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export class UsageError extends Error {}

export interface Context {
  provider: Provider;
  args: string[];
  flags: Set<string>;
  out: (line?: string) => void;
  err: (line?: string) => void;
}

type Command = { usage: string; summary: string; run: (ctx: Context) => Promise<number> | number; hidden?: boolean };

function describe(account: Account): string {
  const extra = [account.plan, account.email].filter(Boolean).join(", ");
  return extra ? `${account.label} (${extra})` : account.label;
}

function accountRows(registry: Registry): string[][] {
  return registry.accounts.map((a) => [
    a.id === registry.active ? style.green("*") : " ",
    style.bold(a.id),
    a.label === a.id ? "" : a.label,
    a.plan || style.dim("no plan"),
    a.email || style.dim("not signed in"),
    a.org ? style.dim(a.org) : "",
  ]);
}

export function printAccounts(ctx: Context, registry: Registry): void {
  ctx.out(`${style.bold(ctx.provider.name)} ${style.dim(`· ${registry.switch} switching at ${registry.threshold}%`)}`);
  for (const line of table(accountRows(registry))) ctx.out(`  ${line}`);
}

const commands: Record<string, Command> = {
  ui: {
    usage: "ui [--port <n>] [--no-open]",
    summary: "Open a local page to add, switch and watch your accounts",
    async run(ctx) {
      const portIndex = process.argv.indexOf("--port");
      const port = portIndex > -1 ? Number(process.argv[portIndex + 1]) : undefined;
      await startUi({ port: Number.isFinite(port) ? port : undefined, open: !ctx.flags.has("no-open"), log: ctx.out });
      await new Promise(() => undefined); // serve until Ctrl+C or Stop
      return 0;
    },
  },

  list: {
    usage: "list [--json]",
    summary: "Show your accounts; * marks the one new sessions use",
    run(ctx) {
      mutate(ctx.provider, (r) => refreshIdentities(ctx.provider, r));
      const current = load(ctx.provider);
      if (ctx.flags.has("json")) {
        ctx.out(JSON.stringify(current, null, 2));
        return 0;
      }
      printAccounts(ctx, current);
      if (current.accounts.length === 1) ctx.out(style.dim(`\n  Add another subscription with: agent-switch add <name>`));
      return 0;
    },
  },

  add: {
    usage: "add [name] [--events]",
    summary: "Sign in to another subscription in a private browser window",
    async run(ctx) {
      let name = ctx.args.join(" ").trim();
      if (ctx.flags.has("events")) {
        return withEvents(ctx, async (emit) => {
          const result = await addAccount(ctx.provider, name, { log: (l) => emit("status", l), runner: eventRunner(emit) });
          emit("done", JSON.stringify(result));
        });
      }
      if (!name && process.stdin.isTTY && ctx.provider.signedIn(ctx.provider.primaryHome())) name = await ask("Name this account (e.g. Personal): ");
      const result = await addAccount(ctx.provider, name, { log: ctx.out });
      const names = result.accounts.map(describe).join(", ");
      if (result.kind === "primary") ctx.out(style.green(`Signed in as ${names}. This is your Main account.`));
      else if (result.kind === "recovered") ctx.out(style.green(`Finished an interrupted sign-in: added ${names}.`));
      else {
        ctx.out(style.green(`Added ${names}.`));
        ctx.out(`Make new sessions use it with: agent-switch use ${result.accounts[0]!.id}`);
      }
      return 0;
    },
  },

  login: {
    usage: "login <account> [--events]",
    summary: "Sign an account in again after its sign-in lapsed",
    async run(ctx) {
      const target = ctx.args.join(" ");
      if (!target) throw new UsageError("Which account? agent-switch login <account>");
      const account = mustFind(ctx.provider, load(ctx.provider), target);
      if (ctx.flags.has("events")) {
        return withEvents(ctx, async (emit) => {
          await reauth(ctx.provider, account, { log: (l) => emit("status", l), runner: eventRunner(emit) });
          mutate(ctx.provider, (r) => refreshIdentities(ctx.provider, r));
          if (!ctx.provider.signedIn(account.home || ctx.provider.primaryHome())) throw new AccountError("The sign-in didn't finish.");
          emit("done", JSON.stringify({ kind: "login", accounts: [find(load(ctx.provider), account.id)] }));
        });
      }
      await reauth(ctx.provider, account, { log: ctx.out });
      const after = ctx.provider.identity(account.home || ctx.provider.primaryHome());
      if (account.accountId && after.accountId && after.accountId !== account.accountId) {
        ctx.err(style.errYellow(`Heads up: that home is now signed in as ${after.email || after.accountId}, not ${account.email || account.label}.`));
      }
      mutate(ctx.provider, (r) => refreshIdentities(ctx.provider, r));
      return ctx.provider.signedIn(account.home || ctx.provider.primaryHome()) ? 0 : 1;
    },
  },

  use: {
    usage: "use [account|next]",
    summary: "Choose the account new sessions start as (running ones stay put)",
    run(ctx) {
      const { previous, current } = use(ctx.provider, ctx.args.join(" ") || "next");
      if (ctx.flags.has("json")) {
        ctx.out(JSON.stringify({ previous, current, signedIn: ctx.provider.signedIn(current.home || ctx.provider.primaryHome()) }));
        return 0;
      }
      if (previous.id === current.id) ctx.out(`New ${ctx.provider.name} sessions already use ${describe(current)}.`);
      else {
        ctx.out(`New ${ctx.provider.name} sessions now use ${style.bold(describe(current))}.`);
        ctx.out(style.dim(`Running sessions stay on ${previous.label}.`));
      }
      if (!ctx.provider.signedIn(current.home || ctx.provider.primaryHome())) {
        ctx.err(style.errYellow(`${current.label} isn't signed in. Run: agent-switch login ${current.id}`));
      }
      return 0;
    },
  },

  rename: {
    usage: "rename <account> <new name>",
    summary: "Rename an account",
    run(ctx) {
      const [target, ...rest] = ctx.args;
      if (!target || rest.length === 0) throw new UsageError("agent-switch rename <account> <new name>");
      const account = rename(ctx.provider, target, rest.join(" "));
      if (ctx.flags.has("json")) {
        ctx.out(JSON.stringify(account));
        return 0;
      }
      ctx.out(`Renamed ${account.id} to ${account.label}.`);
      return 0;
    },
  },

  remove: {
    usage: "remove <account>",
    summary: "Forget an account and delete the home agent-switch made for it",
    run(ctx) {
      const target = ctx.args.join(" ");
      if (!target) throw new UsageError("Which account? agent-switch remove <account>");
      const { account, deletedHome } = remove(ctx.provider, target);
      if (ctx.flags.has("json")) {
        ctx.out(JSON.stringify({ account, deletedHome }));
        return 0;
      }
      ctx.out(`Removed ${describe(account)}.`);
      if (!deletedHome) ctx.out(style.dim(`Its home was adopted, so it was left in place: ${account.home}`));
      return 0;
    },
  },

  mode: {
    usage: "mode [manual|auto] [threshold]",
    summary: "Notify (manual) or switch new sessions automatically (auto) near a limit",
    run(ctx) {
      const [mode, threshold] = ctx.args;
      const registry = mode ? setMode(ctx.provider, mode, threshold) : load(ctx.provider);
      if (ctx.flags.has("json")) {
        ctx.out(JSON.stringify({ switch: registry.switch, threshold: registry.threshold }));
        return 0;
      }
      if (registry.switch === "auto") {
        ctx.out(`${ctx.provider.name} moves new sessions to the account with the most room once the active one reaches ${registry.threshold}%.`);
      } else {
        ctx.out(`${ctx.provider.name} warns at ${registry.threshold}% and switches only when you say so.`);
      }
      return 0;
    },
  },

  adopt: {
    usage: "adopt <dir> [name]",
    summary: "Register a config dir that's already signed in, in place",
    run(ctx) {
      const [dir, ...rest] = ctx.args;
      if (!dir) throw new UsageError("agent-switch adopt <dir> [name]");
      const account = adopt(ctx.provider, dir, rest.join(" "));
      ctx.out(style.green(`Added ${describe(account)} from ${account.home}.`));
      return 0;
    },
  },

  import: {
    usage: "import omarchy",
    summary: "Adopt the accounts Omarchy's agent accounts already manage",
    run(ctx) {
      if (ctx.args[0] !== "omarchy") throw new UsageError("agent-switch import omarchy");
      const { added, skipped } = importOmarchy(ctx.provider);
      for (const account of added) ctx.out(style.green(`Added ${describe(account)}.`));
      for (const { label, reason } of skipped) ctx.out(style.dim(`Skipped ${label}: ${reason}`));
      if (!added.length && !skipped.length) ctx.out("Omarchy has no added accounts to import.");
      return 0;
    },
  },

  run: {
    usage: "run [--as <account>] [--no-check] [-- claude args]",
    summary: "Start Claude Code as the active account (what the `claude` shell function calls)",
    run: () => 0, // handled before argument parsing; see runClaude
  },

  "shell-init": {
    usage: "shell-init [bash|zsh|fish|powershell]",
    summary: "Print the `claude` shell function to load from your shell's startup file",
    run(ctx) {
      const shell = (ctx.args[0] || defaultShell()).toLowerCase();
      const onPath = Boolean(resolveBinary("agent-switch"));
      const script = fs.realpathSync(process.argv[1]!);
      ctx.out("# agent-switch: start Claude Code as the account you picked");
      if (shell === "fish") {
        const self = onPath ? "command agent-switch" : `${quote(process.execPath)} ${quote(script)}`;
        ctx.out(`function claude --wraps claude; ${self} run -- $argv; end`);
      } else if (shell === "bash" || shell === "zsh" || shell === "sh") {
        const self = onPath ? "command agent-switch" : `${quote(process.execPath)} ${quote(script)}`;
        ctx.out(`claude() { ${self} run -- "$@"; }`);
      } else if (shell === "powershell" || shell === "pwsh") {
        const self = onPath ? "agent-switch" : `'${process.execPath.replace(/'/g, "''")}' '${script.replace(/'/g, "''")}'`;
        ctx.out(`function claude { & ${self} run -- @args }`);
      } else {
        throw new UsageError("agent-switch shell-init [bash|zsh|fish|powershell]");
      }
      return 0;
    },
  },

  status: {
    usage: "status [--refresh] [--json]",
    summary: "Show every account's limits and when they reset",
    async run(ctx) {
      mutate(ctx.provider, (r) => refreshIdentities(ctx.provider, r));
      const registry = load(ctx.provider);
      const usage = await collectAll(ctx.provider, registry.accounts, { force: ctx.flags.has("refresh") });
      if (ctx.flags.has("json")) {
        ctx.out(JSON.stringify({ ...registry, usage: Object.fromEntries(usage) }, null, 2));
        return 0;
      }
      printStatus(ctx, registry, usage);
      return 0;
    },
  },

  check: {
    usage: "check [--notify] [--quiet]",
    summary: "Refresh limits and apply the switching policy (for cron or a systemd timer)",
    async run(ctx) {
      const { applied } = await checkAndApply(ctx.provider, { budgetMs: 15_000 });
      if (applied) {
        if (!ctx.flags.has("quiet")) {
          ctx.out(applied.title);
          ctx.out(style.dim(applied.body));
        }
        if (ctx.flags.has("notify")) desktopNotify(applied.title, applied.body, applied.decision.action === "exhausted");
      } else if (!ctx.flags.has("quiet")) {
        ctx.out("Nothing to do.");
      }
      return 0;
    },
  },

  doctor: {
    usage: "doctor",
    summary: "Check the setup and say how to fix anything wrong",
    run(ctx) {
      const findings = diagnose(ctx.provider);
      const mark = { ok: style.green("✓"), warn: style.yellow("!"), fail: style.red("✗") };
      for (const f of findings) {
        ctx.out(`${mark[f.level]} ${f.message}`);
        if (f.fix) ctx.out(style.dim(`    ${f.fix}`));
      }
      const failed = findings.filter((f) => f.level === "fail").length;
      const warned = findings.filter((f) => f.level === "warn").length;
      ctx.out("");
      ctx.out(failed ? style.red(`${failed} problem${failed > 1 ? "s" : ""} to fix.`) : warned ? style.yellow("Working, with suggestions above.") : style.green("All good."));
      return failed ? 1 : 0;
    },
  },

  repair: {
    usage: "repair",
    summary: "Re-create missing shared links in every account home",
    hidden: true,
    run(ctx) {
      const unshared = repairLinks(ctx.provider, load(ctx.provider));
      if (unshared.length) {
        ctx.out(style.yellow(`Couldn't link ${unshared.join(", ")}: Windows needs Developer Mode for file links.`));
        ctx.out(style.dim("Turn it on in Settings > System > For developers, then run agent-switch repair again."));
      } else ctx.out("Shared links are in place.");
      return 0;
    },
  },
};

/**
 * Machine-readable progress for UIs: one `@@agent-switch <event> <detail>`
 * line per step, ending in `done <json>` or `error <message>`.
 */
async function withEvents(ctx: Context, body: (emit: (event: string, detail: string) => void) => Promise<void>): Promise<number> {
  const emit = (event: string, detail: string) => ctx.out(`@@agent-switch ${event} ${detail.replace(/[\r\n]+/g, " ")}`);
  try {
    await body(emit);
    return 0;
  } catch (error) {
    emit("error", error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function defaultShell(): string {
  if (process.env.SHELL) return path.basename(process.env.SHELL);
  return isWindows() ? "powershell" : "bash";
}

async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const STATUS_NOTES: Partial<Record<AccountUsage["status"], string>> = {
  "signed-out": "not signed in",
  refused: "sign-in refused",
  paused: "token expired, numbers paused",
  "rate-limited": "checks rate limited",
  unreachable: "couldn't reach Anthropic",
  error: "check failed",
};

export function printStatus(ctx: Context, registry: Registry, usage: Map<string, AccountUsage>): void {
  const now = Date.now();
  ctx.out(`${style.bold(ctx.provider.name)} ${style.dim(`· ${registry.switch} switching at ${registry.threshold}%`)}`);
  for (const account of registry.accounts) {
    const info = usage.get(account.id);
    const isActive = account.id === registry.active;
    const level = peak(info?.limits, now);
    const head = [
      isActive ? style.green("*") : " ",
      style.bold(account.label),
      account.plan ? style.dim(account.plan) : "",
      account.email ? style.dim(account.email) : "",
      isActive ? style.green("ACTIVE") : "",
    ].filter(Boolean);
    ctx.out("");
    ctx.out(head.join("  "));
    const note = info && STATUS_NOTES[info.status];
    if (info?.limits.length) {
      const rows = info.limits.map((limit) => {
        const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
        const open = Number.isNaN(reset) || reset > now;
        const shown = open ? limit.percent : 0;
        return [
          `    ${limit.label}`,
          meter(shown, registry.threshold),
          `${Math.floor(shown * 100)}%`.padStart(4),
          Number.isNaN(reset) ? "" : style.dim(open ? `resets in ${duration(reset - now)}` : "reset"),
        ];
      });
      for (const line of table(rows)) ctx.out(line);
    }
    if (note || info?.stale) {
      const when = info?.fetchedAt ? `as of ${age(now - info.fetchedAt)}` : "";
      ctx.out(style.dim(`    ${[note, when].filter(Boolean).join(", ")}${info?.message ? `. ${info.message}` : ""}`));
    } else if (!info?.limits.length) {
      ctx.out(style.dim("    no limits known yet"));
    }
    if (level !== undefined && level >= registry.threshold && isActive && registry.accounts.length > 1) {
      ctx.out(style.yellow(`    over the ${registry.threshold}% threshold`));
    }
  }
}

/**
 * `agent-switch run`: decide the account, then hand the terminal to the real
 * Claude Code. Anything that goes wrong before the hand-off warns and starts
 * Claude as usual: the shell function must never stop `claude` from working.
 */
export async function runClaude(provider: Provider, argv: string[]): Promise<number> {
  let explicit: string | undefined;
  let check = !process.env.AGENT_SWITCH_NO_CHECK;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--no-check") check = false;
    else if (arg === "--as") explicit = argv[++i];
    else if (arg.startsWith("--as=")) explicit = arg.slice(5);
    else break;
  }
  const args = argv.slice(i);
  const binary = resolveBinary(provider.binary);
  if (!binary) {
    process.stderr.write(style.errRed(`agent-switch: \`${provider.binary}\` isn't on your PATH. Install Claude Code first.`) + "\n");
    return 127;
  }
  if (explicit !== undefined && !find(load(provider), explicit)) {
    process.stderr.write(style.errRed(`agent-switch: no ${provider.name} account named "${explicit}".`) + "\n");
    return 1;
  }

  let env: NodeJS.ProcessEnv = process.env;
  try {
    let registry = load(provider);
    let target = launchTarget(provider, registry, explicit);
    if (check && target.kind === "account" && target.reason === "active") {
      const result = await checkAndApply(provider);
      if (result.applied) {
        process.stderr.write(`${style.errYellow(result.applied.title)}\n${result.applied.body}\n`);
        if (result.applied.switched) desktopNotify(result.applied.title, result.applied.body);
      }
      registry = result.registry;
      target = launchTarget(provider, registry, explicit);
    }
    if (target.kind === "account") env = accountEnv(provider, target.account);
  } catch (error) {
    process.stderr.write(style.errYellow(`agent-switch: ${(error as Error).message}. Starting ${provider.name} as usual.`) + "\n");
    env = process.env;
  }
  return runAttached(binary, args, env);
}

export function registerCommand(name: string, command: Command): void {
  commands[name] = command;
}

function help(): string {
  const rows = Object.entries(commands)
    .filter(([, c]) => !c.hidden)
    .map(([, c]) => [`  agent-switch ${c.usage}`, style.dim(c.summary)]);
  return [
    `${style.bold("agent-switch")} ${version}: several Claude Code subscriptions on one machine`,
    "",
    "Usage:",
    ...table(rows),
    "",
    "Accounts can be named by id, name, or email. `asw` is a short alias.",
    "",
  ].join("\n");
}

export function parse(argv: string[]): { command: string; provider: Provider; args: string[]; flags: Set<string> } {
  const flags = new Set<string>();
  const positional: string[] = [];
  let passthrough = false;
  for (const arg of argv) {
    if (passthrough) positional.push(arg);
    else if (arg === "--") passthrough = true;
    else if (arg.startsWith("--") && arg.length > 2) flags.add(arg.slice(2));
    else if (arg === "-h") flags.add("help");
    else if (arg === "-v") flags.add("version");
    else positional.push(arg);
  }
  let [command = "", ...args] = positional;
  // `agent-switch use claude work` and `agent-switch use work` mean the same.
  let provider = claude;
  if (args[0] && PROVIDERS[args[0]] && command !== "adopt") {
    provider = PROVIDERS[args.shift()!]!;
  }
  return { command, provider, args, flags };
}

export async function main(argv: string[]): Promise<number> {
  // `run` passes everything after it to Claude untouched, flags included.
  if (argv[0] === "run") return runClaude(claude, argv.slice(1));
  const { command, provider, args, flags } = parse(argv);
  const out = (line = "") => process.stdout.write(line + "\n");
  const err = (line = "") => process.stderr.write(line + "\n");
  if (flags.has("version") || command === "version") {
    out(version);
    return 0;
  }
  if (!command || command === "help" || (flags.has("help") && !commands[command])) {
    out(help());
    return 0;
  }
  const entry = commands[command];
  if (!entry) {
    err(`Unknown command "${command}". Run agent-switch help.`);
    return 2;
  }
  if (flags.has("help")) {
    out(`Usage: agent-switch ${entry.usage}\n\n${entry.summary}`);
    return 0;
  }
  try {
    return await entry.run({ provider, args, flags, out, err });
  } catch (error) {
    if (error instanceof UsageError) {
      err(`Usage: ${error.message}`);
      return 2;
    }
    if (error instanceof AccountError) {
      err(style.errRed(error.message));
      return 1;
    }
    throw error;
  }
}

// Only run when executed, not when imported by tests.
const invoked = process.argv[1] ? (await import("node:fs")).realpathSync(process.argv[1]) : "";
if (invoked === (await import("node:url")).fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`agent-switch: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
