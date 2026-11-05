import { active, type Account, type Registry } from "./registry.js";
import type { AccountUsage, Limit } from "./usage.js";

/** Points under the threshold where an account counts as close to its limit. */
export const NEAR_MARGIN = 15;

function resetMs(limit: Limit): number | undefined {
  if (!limit.resetsAt) return undefined;
  const t = Date.parse(limit.resetsAt);
  return Number.isNaN(t) ? undefined : t;
}

/** A window whose reset time has passed is empty, however old the numbers. */
export function windowOpen(limit: Limit, now: number): boolean {
  const reset = resetMs(limit);
  return reset === undefined || reset > now;
}

/**
 * How spent an account is, in percent: its fullest window that hasn't reset.
 * Undefined when nothing is known about it at all.
 */
export function peak(limits: Limit[] | undefined, now: number): number | undefined {
  if (!limits || limits.length === 0) return undefined;
  const open = limits.filter((l) => windowOpen(l, now)).map((l) => l.percent * 100);
  return open.length ? Math.max(...open) : 0;
}

export function nextReset(limits: Limit[] | undefined, now: number): number | undefined {
  const times = (limits ?? []).map(resetMs).filter((t): t is number => t !== undefined && t > now);
  return times.length ? Math.min(...times) : undefined;
}

/**
 * When an account over the threshold drops back under it: once every window
 * holding it there has reset, i.e. the latest of those resets. A session
 * window resetting in an hour doesn't help a week that's full for six days.
 */
export function availableAt(limits: Limit[] | undefined, threshold: number, now: number): number | undefined {
  let latest: number | undefined;
  for (const limit of limits ?? []) {
    if (limit.percent * 100 < threshold || !windowOpen(limit, now)) continue;
    const reset = resetMs(limit);
    if (reset === undefined) return undefined;
    latest = latest === undefined ? reset : Math.max(latest, reset);
  }
  return latest;
}

export type Decision =
  | { action: "clear" }
  | { action: "switch" | "notify"; alert: string; from: Account; to: Account; fromPeak: number; toPeak: number }
  | { action: "exhausted"; alert: string; from: Account; fromPeak: number; soonest?: { at: number; account: Account } };

/**
 * The whole switching policy, with no I/O.
 *
 * Only the active account crossing the threshold starts anything, so auto
 * mode never flaps back to an account that just reset. `registry.alert`
 * remembers the last thing said so it isn't repeated on every launch.
 *
 * Among accounts with room, ones not near their own limit come first, then
 * fresh numbers before stale ones, then the emptiest, then the soonest reset.
 * A stale account is still a candidate: a parked account's token lapses
 * within hours and can't be checked again until a session runs in it.
 */
export function decide(registry: Registry, usage: Map<string, AccountUsage>, now: number): Decision | undefined {
  const threshold = registry.threshold;
  const current = active(registry);
  const currentPeak = peak(usage.get(current.id)?.limits, now);
  if (currentPeak === undefined || currentPeak < threshold) {
    return registry.alert ? { action: "clear" } : undefined;
  }

  const candidates: { near: boolean; stale: boolean; level: number; reset: number; account: Account }[] = [];
  for (const account of registry.accounts) {
    if (account.id === current.id) continue;
    const info = usage.get(account.id);
    // An account nobody is signed in to can't start a session, whatever it had.
    if (!info || info.status === "signed-out" || info.status === "refused") continue;
    const level = peak(info.limits, now);
    if (level === undefined || level >= threshold) continue;
    candidates.push({
      near: level >= threshold - NEAR_MARGIN,
      stale: info.stale,
      level,
      reset: nextReset(info.limits, now) ?? Number.MAX_SAFE_INTEGER,
      account,
    });
  }
  candidates.sort(
    (a, b) => Number(a.near) - Number(b.near) || Number(a.stale) - Number(b.stale) || a.level - b.level || a.reset - b.reset,
  );

  const best = candidates[0];
  if (best) {
    const action = registry.switch === "auto" ? "switch" : "notify";
    const alert = `${action}:${current.id}:${best.account.id}`;
    if (registry.alert === alert) return undefined;
    return { action, alert, from: current, to: best.account, fromPeak: currentPeak, toPeak: best.level };
  }

  const alert = `exhausted:${current.id}`;
  if (registry.alert === alert || registry.accounts.length < 2) return undefined;
  // Only when every account is known to be over: one that couldn't be
  // checked might have room, so there's nothing honest to say.
  // A signed-out account is unknown too, not full.
  const unknown = (a: Account) => {
    const info = usage.get(a.id);
    return !info || info.status === "signed-out" || info.status === "refused" || peak(info.limits, now) === undefined;
  };
  if (registry.accounts.some(unknown)) return undefined;
  let soonest: { at: number; account: Account } | undefined;
  for (const account of registry.accounts) {
    const at = availableAt(usage.get(account.id)?.limits, threshold, now);
    if (at !== undefined && (!soonest || at < soonest.at)) soonest = { at, account };
  }
  return { action: "exhausted", alert, from: current, fromPeak: currentPeak, soonest };
}
