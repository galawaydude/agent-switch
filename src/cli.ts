#!/usr/bin/env node
import { createRequire } from "node:module";
import { PROVIDERS, claude } from "./claude.js";
import { style, table } from "./format.js";
import { adopt, importOmarchy, repairLinks } from "./homes.js";
import { addAccount, reauth } from "./login.js";
import type { Provider } from "./provider.js";
import {
  AccountError,
  load,
  mustFind,
  mutate,
  refreshIdentities,
  remove,
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
    usage: "add [name]",
    summary: "Sign in to another subscription in a private browser window",
    async run(ctx) {
      const result = await addAccount(ctx.provider, ctx.args.join(" "), ctx.out);
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
    usage: "login <account>",
    summary: "Sign an account in again after its sign-in lapsed",
    async run(ctx) {
      const target = ctx.args.join(" ");
      if (!target) throw new UsageError("Which account? agent-switch login <account>");
      const account = mustFind(ctx.provider, load(ctx.provider), target);
      await reauth(ctx.provider, account, ctx.out);
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
      if (previous.id === current.id) ctx.out(`New ${ctx.provider.name} sessions already use ${describe(current)}.`);
      else {
        ctx.out(`New ${ctx.provider.name} sessions now use ${style.bold(describe(current))}.`);
        ctx.out(style.dim(`Running sessions stay on ${previous.label}.`));
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

  repair: {
    usage: "repair",
    summary: "Re-create missing shared links in every account home",
    hidden: true,
    run(ctx) {
      repairLinks(ctx.provider, load(ctx.provider));
      ctx.out("Shared links are in place.");
      return 0;
    },
  },
};

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
