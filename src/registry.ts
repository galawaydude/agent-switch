import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJson, str, withLock, writeJsonAtomic } from "./fsutil.js";
import { homesRoot, isInside, lockPath, registryPath } from "./paths.js";
import type { Identity, Provider } from "./provider.js";

export const DEFAULT_THRESHOLD = 95;
export const MIN_THRESHOLD = 50;
export const MAX_THRESHOLD = 100;
export const SWITCH_MODES = ["manual", "auto"] as const;
export type SwitchMode = (typeof SWITCH_MODES)[number];

/** Ids that already mean something on the command line. */
export const RESERVED_IDS = new Set(["next", "add", "all", "primary", "pending", "claude", "codex", "grok"]);

export interface Account extends Identity {
  id: string;
  label: string;
  /** Absolute config home; empty for the primary account. */
  home: string;
  primary: boolean;
}

export interface Registry {
  version: 1;
  active: string;
  switch: SwitchMode;
  threshold: number;
  /** The last switching message given, so it isn't repeated. */
  alert: string;
  accounts: Account[];
}

export class AccountError extends Error {}

export function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function accountHome(provider: Provider, account: Account): string {
  return account.home || provider.primaryHome();
}

function primaryEntry(provider: Provider): Account {
  return { id: "main", label: "Main", home: "", primary: true, ...provider.identity(provider.primaryHome()) };
}

function normalizedAccount(value: unknown): Account | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value.id);
  if (!id) return undefined;
  return {
    id,
    label: str(value.label) || id,
    home: str(value.home),
    primary: value.primary === true,
    accountId: str(value.accountId),
    email: str(value.email),
    org: str(value.org),
    plan: str(value.plan),
  };
}

export function clampThreshold(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(str(value), 10);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Math.round(n)));
}

/** Turn whatever is on disk into a registry that is always safe to use. */
export function normalize(provider: Provider, data: unknown): Registry {
  const raw = isRecord(data) ? data : {};
  const seen = new Set<string>();
  const accounts: Account[] = [];
  for (const value of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const account = normalizedAccount(value);
    if (!account || seen.has(account.id)) continue;
    // Only one primary: it is the CLI's own home, and it never has a home path.
    if (account.primary && accounts.some((a) => a.primary)) continue;
    if (account.primary) account.home = "";
    if (!account.primary && !account.home) continue;
    seen.add(account.id);
    accounts.push(account);
  }
  if (!accounts.some((a) => a.primary)) accounts.unshift(primaryEntry(provider));
  else accounts.sort((a, b) => Number(b.primary) - Number(a.primary));

  const mode = SWITCH_MODES.includes(raw.switch as SwitchMode) ? (raw.switch as SwitchMode) : "manual";
  const active = accounts.some((a) => a.id === raw.active) ? str(raw.active) : accounts[0]!.id;
  return {
    version: 1,
    active,
    switch: mode,
    threshold: raw.threshold === undefined ? DEFAULT_THRESHOLD : clampThreshold(raw.threshold),
    alert: str(raw.alert),
    accounts,
  };
}

export function load(provider: Provider): Registry {
  return normalize(provider, readJson(registryPath(provider.id)));
}

export function save(provider: Provider, registry: Registry): void {
  writeJsonAtomic(registryPath(provider.id), registry);
}

/** Load, change and save the registry under its lock. */
export function mutate<T>(provider: Provider, fn: (registry: Registry) => T): T {
  return withLock(lockPath(provider.id), () => {
    const registry = load(provider);
    const result = fn(registry);
    save(provider, registry);
    return result;
  });
}

export function find(registry: Registry, target: string): Account | undefined {
  const wanted = target.trim().toLowerCase();
  if (!wanted) return undefined;
  return (
    registry.accounts.find((a) => a.id === wanted) ??
    registry.accounts.find((a) => a.label.toLowerCase() === wanted) ??
    (wanted === "primary" ? registry.accounts.find((a) => a.primary) : undefined) ??
    registry.accounts.find((a) => a.email && a.email.toLowerCase() === wanted)
  );
}

export function active(registry: Registry): Account {
  return registry.accounts.find((a) => a.id === registry.active) ?? registry.accounts[0]!;
}

export function mustFind(provider: Provider, registry: Registry, target: string): Account {
  const account = find(registry, target);
  if (!account) {
    const names = registry.accounts.map((a) => a.id).join(", ");
    throw new AccountError(`No ${provider.name} account named "${target}". Accounts: ${names}`);
  }
  return account;
}

/** A free id for a label: its slug, or the slug with -2, -3... */
export function uniqueId(provider: Provider, registry: Registry, label: string): string {
  let base = slug(label) || "account";
  if (RESERVED_IDS.has(base) || base === "main") base = `${base}-account`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (registry.accounts.some((a) => a.id === id)) continue;
    if (fs.existsSync(path.join(homesRoot(provider.id), id))) continue;
    return id;
  }
}

/** Re-read who every home is signed in as; a hand-run login can change it. */
export function refreshIdentities(provider: Provider, registry: Registry): void {
  for (const account of registry.accounts) {
    const found = provider.identity(accountHome(provider, account));
    if (found.accountId) Object.assign(account, found);
  }
}

export function use(provider: Provider, target: string): { previous: Account; current: Account } {
  return mutate(provider, (registry) => {
    const previous = active(registry);
    let account: Account;
    if (target === "next") {
      const index = registry.accounts.findIndex((a) => a.id === previous.id);
      account = registry.accounts[(index + 1) % registry.accounts.length]!;
    } else {
      account = mustFind(provider, registry, target);
    }
    registry.active = account.id;
    registry.alert = "";
    return { previous, current: account };
  });
}

export function rename(provider: Provider, target: string, label: string): Account {
  const clean = label.trim();
  if (!clean) throw new AccountError("Give the account a name.");
  return mutate(provider, (registry) => {
    const account = mustFind(provider, registry, target);
    const clash = find(registry, clean);
    if (clash && clash.id !== account.id) throw new AccountError(`"${clean}" is already ${clash.label}.`);
    account.label = clean;
    return account;
  });
}

export function setMode(provider: Provider, mode: string, threshold?: string): Registry {
  if (!SWITCH_MODES.includes(mode as SwitchMode)) throw new AccountError("Switch mode is manual or auto.");
  let parsed: number | undefined;
  if (threshold !== undefined) {
    parsed = Number.parseInt(threshold.replace(/%$/, ""), 10);
    if (!Number.isFinite(parsed) || parsed < MIN_THRESHOLD || parsed > MAX_THRESHOLD) {
      throw new AccountError(`The threshold is a percentage from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}.`);
    }
  }
  return mutate(provider, (registry) => {
    registry.switch = mode as SwitchMode;
    if (parsed !== undefined) registry.threshold = parsed;
    registry.alert = "";
    return { ...registry };
  });
}

/**
 * Whether a running process was started with this home as its config dir.
 * Removing that home would pull the login out from under a live session.
 * Linux exposes environments in /proc; elsewhere we can't tell and say no.
 */
export function homeInUse(provider: Provider, home: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return false;
  }
  const wanted = Buffer.from(`${provider.homeEnv}=`);
  const resolved = path.resolve(home);
  for (const pid of entries) {
    if (Number(pid) === process.pid) continue;
    let environ: Buffer;
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`);
    } catch {
      continue;
    }
    let start = 0;
    while (start < environ.length) {
      let end = environ.indexOf(0, start);
      if (end === -1) end = environ.length;
      const entry = environ.subarray(start, end);
      if (entry.subarray(0, wanted.length).equals(wanted)) {
        const value = entry.subarray(wanted.length).toString();
        if (value && path.resolve(value) === resolved) return true;
      }
      start = end + 1;
    }
  }
  return false;
}

export function remove(provider: Provider, target: string): { account: Account; deletedHome: boolean } {
  return mutate(provider, (registry) => {
    const account = mustFind(provider, registry, target);
    if (account.primary) {
      throw new AccountError(`${account.label} is the login in ${provider.primaryHome()}; it can't be removed.`);
    }
    const home = accountHome(provider, account);
    if (homeInUse(provider, home)) {
      throw new AccountError(`A running ${provider.name} session uses ${account.label}. Quit it first, then remove the account.`);
    }
    // Only a home agent-switch made is deleted. Its shared entries are links,
    // and rm removes a link without following it. An adopted home stays.
    let deletedHome = false;
    if (isInside(home, homesRoot(provider.id)) && !fs.lstatSync(home, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.rmSync(home, { recursive: true, force: true });
      deletedHome = true;
    }
    registry.accounts = registry.accounts.filter((a) => a.id !== account.id);
    if (registry.active === account.id) registry.active = registry.accounts[0]!.id;
    registry.alert = "";
    return { account, deletedHome };
  });
}
