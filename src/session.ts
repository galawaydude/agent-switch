import { spawn } from "node:child_process";
import { duration } from "./format.js";
import { resolveBinary } from "./launch.js";
import { isMac } from "./platform.js";
import { decide, type Decision } from "./policy.js";
import type { Provider } from "./provider.js";
import { active, find, load, mutate, type Account, type Registry } from "./registry.js";
import { collectAll, type AccountUsage } from "./usage.js";

/** Longest a launch waits on limit checks before starting anyway. */
export const LAUNCH_CHECK_BUDGET_MS = 3_000;

export interface Applied {
  decision: Decision;
  /** One-line headline and an optional detail line. */
  title: string;
  body: string;
  /** Whether new sessions now start as a different account. */
  switched: boolean;
}

function pct(n: number): string {
  return `${Math.floor(n)}%`;
}

export function describeDecision(provider: Provider, decision: Decision, now: number): { title: string; body: string } {
  switch (decision.action) {
    case "switch":
      return {
        title: `${provider.name}: new sessions now use ${decision.to.label}`,
        body: `${decision.from.label} is at ${pct(decision.fromPeak)}; ${decision.to.label} is at ${pct(decision.toPeak)}. Running sessions stay put.`,
      };
    case "notify":
      return {
        title: `${provider.name}: ${decision.from.label} is at ${pct(decision.fromPeak)}`,
        body: `${decision.to.label} has room (${pct(decision.toPeak)}). Switch with: agent-switch use ${decision.to.id}`,
      };
    case "exhausted": {
      const soon = decision.soonest
        ? `${decision.soonest.account.label} frees up in ${duration(decision.soonest.at - now)}.`
        : "None of them say when they reset.";
      return { title: `${provider.name}: every account is near its limit`, body: soon };
    }
    case "clear":
      return { title: "", body: "" };
  }
}

/**
 * Carry out a decision under the registry lock. If someone changed the active
 * account since the decision was made, it no longer applies and is dropped.
 */
export function applyDecision(provider: Provider, decision: Decision, now: number): Applied | undefined {
  return mutate(provider, (registry) => {
    if (decision.action === "clear") {
      registry.alert = "";
      return undefined;
    }
    if (active(registry).id !== decision.from.id) return undefined;
    registry.alert = decision.alert;
    let switched = false;
    if (decision.action === "switch" && find(registry, decision.to.id)) {
      registry.active = decision.to.id;
      switched = true;
    }
    return { decision, switched, ...describeDecision(provider, decision, now) };
  });
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Refresh limits (within a time budget) and apply the switching policy. */
export async function checkAndApply(
  provider: Provider,
  options: { force?: boolean; budgetMs?: number; now?: number } = {},
): Promise<{ registry: Registry; usage?: Map<string, AccountUsage>; applied?: Applied }> {
  const registry = load(provider);
  if (registry.accounts.length < 2) return { registry };
  const now = options.now ?? Date.now();
  const usage = await withBudget(
    collectAll(provider, registry.accounts, { force: options.force, timeoutMs: options.budgetMs }),
    options.budgetMs ?? LAUNCH_CHECK_BUDGET_MS,
  );
  if (!usage) return { registry };
  const decision = decide(registry, usage, now);
  const applied = decision ? applyDecision(provider, decision, now) : undefined;
  return { registry: load(provider), usage, applied };
}

export type LaunchTarget =
  | { kind: "account"; account: Account; reason: "inherited" | "explicit" | "active" }
  | { kind: "external" };

/**
 * Which account a new session runs as.
 *
 * - A session started from inside another (Claude Code running `claude`) keeps
 *   its parent's account, via AGENT_SWITCH_ACCOUNT.
 * - A CLAUDE_CONFIG_DIR someone set themselves is respected as-is.
 * - `--as` picks one for this launch only.
 * - Otherwise, the registry's active account.
 */
export function launchTarget(provider: Provider, registry: Registry, explicit?: string, env = process.env): LaunchTarget {
  if (explicit) {
    const account = find(registry, explicit);
    if (!account) throw new Error(`No ${provider.name} account named "${explicit}".`);
    return { kind: "account", account, reason: "explicit" };
  }
  const inherited = env.AGENT_SWITCH_ACCOUNT ? find(registry, env.AGENT_SWITCH_ACCOUNT) : undefined;
  if (inherited) return { kind: "account", account: inherited, reason: "inherited" };
  if (env[provider.homeEnv]) return { kind: "external" };
  return { kind: "account", account: active(registry), reason: "active" };
}

/** Best-effort desktop notification; silently does nothing where unsupported. */
export function desktopNotify(title: string, body: string, urgent = false): void {
  if (process.env.AGENT_SWITCH_NO_NOTIFY) return;
  let command: string | undefined;
  let args: string[] = [];
  if (isMac()) {
    command = "osascript";
    const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    args = ["-e", `display notification ${quote(body)} with title ${quote(title)}`];
  } else if (resolveBinary("notify-send")) {
    command = "notify-send";
    args = ["-a", "agent-switch", ...(urgent ? ["-u", "critical"] : []), title, body];
  }
  if (!command) return;
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Notifications are a courtesy.
  }
}
