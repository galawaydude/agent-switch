import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, mkdirPrivate, readJson, readRecord, str, withLock, writeJsonAtomic } from "./fsutil.js";
import { homesRoot, isInside, lockPath, pendingRoot, userHome } from "./paths.js";
import type { Provider } from "./provider.js";
import {
  AccountError,
  accountHome,
  find,
  load,
  refreshIdentities,
  save,
  uniqueId,
  type Account,
  type Registry,
} from "./registry.js";

export const RECEIPT = ".agent-switch-login.json";

interface Receipt {
  label: string;
  owner: number;
  entry?: Account;
}

function lstat(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

/**
 * Lay the links that make an account share everything but its login with the
 * primary home. Safe to repeat: an existing link or real file is left alone,
 * so nothing an account wrote for itself is ever replaced.
 */
export function linkShared(provider: Provider, home: string): void {
  const primary = provider.primaryHome();
  mkdirPrivate(home);
  fs.mkdirSync(primary, { recursive: true });
  for (const name of provider.sharedDirs) {
    const shared = path.join(primary, name);
    const info = lstat(shared);
    // A dangling link is the person's own setup (a dotfiles link that hasn't
    // synced yet): leave it for its target to appear.
    if (info?.isSymbolicLink() && !fs.existsSync(shared)) continue;
    if (!info) fs.mkdirSync(shared, { recursive: true });
  }
  for (const name of [...provider.sharedDirs, ...provider.sharedFiles]) {
    if (provider.credentialFiles.includes(name)) continue;
    const target = path.join(home, name);
    if (lstat(target)) continue;
    fs.symlinkSync(path.join(primary, name), target);
  }
}

function writeReceipt(home: string, receipt: Receipt): void {
  writeJsonAtomic(path.join(home, RECEIPT), receipt);
}

function readReceipt(home: string): Receipt | undefined {
  const data = readJson(path.join(home, RECEIPT));
  if (!isRecord(data)) return undefined;
  return {
    label: str(data.label),
    owner: Number(data.owner) || 0,
    entry: isRecord(data.entry) ? (data.entry as unknown as Account) : undefined,
  };
}

/** A scratch home for a login in progress, already sharing the primary's setup. */
export function beginLogin(provider: Provider, label: string): string {
  mkdirPrivate(homesRoot(provider.id));
  mkdirPrivate(pendingRoot(provider.id));
  const home = fs.mkdtempSync(path.join(pendingRoot(provider.id), "login-"));
  try {
    linkShared(provider, home);
    writeReceipt(home, { label, owner: process.pid });
  } catch (error) {
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return home;
}

function duplicateMessage(existing: Account, email: string): string {
  const who = email ? `${existing.label} (${email})` : existing.label;
  return `That's ${who}, which is already added. Try again and sign in as the other account in the private window.`;
}

/**
 * Turn a finished login in a pending home into a registered account. The
 * receipt records the entry before the home moves, so an interruption between
 * the move and the save is recovered by `recover`.
 */
export function registerLogin(provider: Provider, pending: string, label: string): Account {
  const resolved = path.resolve(pending);
  if (!isInside(resolved, pendingRoot(provider.id))) {
    throw new AccountError(`${pending} is not a pending ${provider.name} login.`);
  }
  const found = provider.identity(resolved);
  if (!found.accountId || !provider.signedIn(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true });
    throw new AccountError("The sign-in didn't finish, so no account was added.");
  }
  return withLock(lockPath(provider.id), () => {
    const registry = load(provider);
    refreshIdentities(provider, registry);
    const existing = registry.accounts.find((a) => a.accountId === found.accountId);
    if (existing) {
      fs.rmSync(resolved, { recursive: true, force: true });
      throw new AccountError(duplicateMessage(existing, found.email));
    }
    const name = uniqueLabel(registry, label.trim() || found.email.split("@")[0] || "Account");
    provider.carrySettings(resolved);
    const id = uniqueId(provider, registry, name);
    const home = path.join(homesRoot(provider.id), id);
    const entry: Account = { id, label: name, home, primary: false, ...found };
    const receipt = readReceipt(resolved) ?? { label: name, owner: process.pid };
    writeReceipt(resolved, { ...receipt, entry });
    fs.renameSync(resolved, home);
    registry.accounts.push(entry);
    try {
      save(provider, registry);
    } catch (error) {
      fs.renameSync(home, resolved);
      throw error;
    }
    fs.rmSync(path.join(home, RECEIPT), { force: true });
    return entry;
  });
}

/** A label no account uses yet: the wanted one, or it with 2, 3... appended. */
export function uniqueLabel(registry: Registry, wanted: string): string {
  for (let n = 1; ; n++) {
    const label = n === 1 ? wanted : `${wanted} ${n}`;
    if (!find(registry, label)) return label;
  }
}

function processAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Finish what an interrupted `add` left behind: a home moved into place whose
 * registry save never happened, or a completed sign-in still pending. Sign-ins
 * whose owner is still running are left to it. Returns what was recovered.
 */
export function recover(provider: Provider): Account[] {
  const recovered: Account[] = [];
  const root = homesRoot(provider.id);
  if (!fs.existsSync(root)) return recovered;

  // Homes already moved into place, still carrying their receipt.
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const home = path.join(root, name);
    const receipt = readReceipt(home);
    if (!receipt?.entry) continue;
    withLock(lockPath(provider.id), () => {
      const registry = load(provider);
      if (!registry.accounts.some((a) => a.id === name)) {
        const entry = { ...receipt.entry!, id: name, home, primary: false };
        registry.accounts.push(entry);
        save(provider, registry);
        recovered.push(entry);
      }
      fs.rmSync(path.join(home, RECEIPT), { force: true });
    });
  }

  const pending = pendingRoot(provider.id);
  if (!fs.existsSync(pending)) return recovered;
  for (const name of fs.readdirSync(pending)) {
    const home = path.join(pending, name);
    const receipt = readReceipt(home);
    if (receipt && processAlive(receipt.owner) && receipt.owner !== process.pid) continue;
    if (!provider.signedIn(home)) {
      fs.rmSync(home, { recursive: true, force: true });
      continue;
    }
    try {
      recovered.push(registerLogin(provider, home, receipt?.label ?? ""));
    } catch {
      // A duplicate or unfinished login was cleaned up by registerLogin.
    }
  }
  return recovered;
}

/**
 * Register a home that is already signed in, where it is. Nothing is copied:
 * two homes holding one login would share a rotating refresh token, and the
 * first refresh would sign the other out.
 */
export function adopt(provider: Provider, dir: string, label: string): Account {
  const home = fs.realpathSync(path.resolve(dir.replace(/^~(?=$|\/)/, userHome())));
  if (!fs.statSync(home).isDirectory()) throw new AccountError(`${dir} is not a directory.`);
  if (home === fs.realpathSync(provider.primaryHome())) {
    throw new AccountError(`${dir} is ${provider.name}'s own home, which is already the Main account.`);
  }
  if (!provider.signedIn(home)) throw new AccountError(`Nobody is signed in to ${provider.name} in ${dir}.`);
  const found = provider.identity(home);
  if (!found.accountId) throw new AccountError(`Couldn't tell which account ${dir} is signed in as.`);
  return withLock(lockPath(provider.id), () => {
    const registry = load(provider);
    refreshIdentities(provider, registry);
    const existing = registry.accounts.find((a) => a.accountId === found.accountId);
    if (existing) throw new AccountError(`${dir} is signed in as ${existing.label}, which is already added.`);
    const sameHome = registry.accounts.find((a) => path.resolve(accountHome(provider, a)) === home);
    if (sameHome) throw new AccountError(`${dir} is already ${sameHome.label}.`);
    const name = label.trim() || found.email.split("@")[0] || path.basename(home);
    if (find(registry, name)) throw new AccountError(`An account is already called "${name}". Pick another name.`);
    linkShared(provider, home);
    const entry: Account = { id: uniqueId(provider, registry, name), label: name, home, primary: false, ...found };
    registry.accounts.push(entry);
    save(provider, registry);
    return entry;
  });
}

export interface ImportResult {
  added: Account[];
  skipped: { label: string; reason: string }[];
}

/** Adopt every added account Omarchy's agent accounts manage for this provider. */
export function importOmarchy(provider: Provider): ImportResult {
  const xdg = process.env.XDG_STATE_HOME || path.join(userHome(), ".local", "state");
  const file = path.join(xdg, "omarchy", "agents", "accounts", `${provider.id}.json`);
  if (!fs.existsSync(file)) throw new AccountError(`No Omarchy ${provider.name} accounts found (${file}).`);
  const accounts = readRecord(file).accounts;
  const result: ImportResult = { added: [], skipped: [] };
  for (const value of Array.isArray(accounts) ? accounts : []) {
    if (!isRecord(value) || value.primary === true || !str(value.home)) continue;
    const label = str(value.label) || str(value.id);
    try {
      result.added.push(adopt(provider, str(value.home), label));
    } catch (error) {
      result.skipped.push({ label, reason: (error as Error).message });
    }
  }
  return result;
}

/** Make sure a registry's added homes still share everything with the primary. */
export function repairLinks(provider: Provider, registry: Registry): void {
  for (const account of registry.accounts) {
    if (!account.primary && fs.existsSync(account.home)) linkShared(provider, account.home);
  }
}
