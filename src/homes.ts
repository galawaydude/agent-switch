import * as fs from "node:fs";
import * as path from "node:path";
import { deleteStoredLogin } from "./credentials.js";
import { isRecord, mkdirPrivate, readJson, readRecord, str, withLock, writeJsonAtomic } from "./fsutil.js";
import { homesRoot, isInside, lockPath, pendingRoot, userHome } from "./paths.js";
import { isWindows } from "./platform.js";
import type { Provider } from "./provider.js";
import {
  AccountError,
  accountHome,
  find,
  homeInUse,
  load,
  mustFind,
  mutate,
  refreshIdentities,
  save,
  uniqueId,
  type Account,
  type Registry,
} from "./registry.js";

/** Marks a home whose sign-in hasn't been registered yet. */
export const RECEIPT = ".agent-switch-login.json";

interface Receipt {
  label: string;
  owner: number;
}

function lstat(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

/**
 * Lay the links that make an account share everything but its login with the
 * primary home. Safe to repeat: an existing link or real file is left alone,
 * so nothing an account wrote for itself is ever replaced.
 *
 * On Windows, directories become junctions (no admin rights needed). Files
 * need symlink rights (Developer Mode); without them they aren't shared, and
 * their names are returned so the caller can say so. Hard links aren't a
 * fallback: Claude Code replaces files atomically, which silently splits them.
 */
export function linkShared(provider: Provider, home: string): string[] {
  const primary = provider.primaryHome();
  const unshared: string[] = [];
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
  for (const name of provider.sharedDirs) {
    const target = path.join(home, name);
    if (lstat(target)) continue;
    fs.symlinkSync(path.join(primary, name), target, isWindows() ? "junction" : "dir");
  }
  for (const name of provider.sharedFiles) {
    if (provider.credentialFiles.includes(name)) continue;
    const target = path.join(home, name);
    if (lstat(target)) continue;
    try {
      fs.symlinkSync(path.join(primary, name), target, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (isWindows() && (code === "EPERM" || code === "EACCES")) unshared.push(name);
      else throw error;
    }
  }
  return unshared;
}

/**
 * Delete a home agent-switch made. Its links are removed first, one by one,
 * so nothing can ever follow a link or junction into the primary home. On
 * macOS its Keychain login goes too.
 */
export function removeHome(provider: Provider, home: string): void {
  if (!isInside(home, homesRoot(provider.id))) throw new AccountError(`Refusing to delete ${home}: agent-switch didn't make it.`);
  const info = lstat(home);
  if (!info) return;
  if (info.isSymbolicLink()) {
    fs.unlinkSync(home);
    return;
  }
  for (const name of fs.readdirSync(home)) {
    const entry = path.join(home, name);
    if (!lstat(entry)?.isSymbolicLink()) continue;
    try {
      fs.unlinkSync(entry);
    } catch {
      fs.rmdirSync(entry); // a Windows junction
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
  deleteStoredLogin(home);
}

function writeReceipt(home: string, receipt: Receipt): void {
  writeJsonAtomic(path.join(home, RECEIPT), receipt);
}

function readReceipt(home: string): Receipt | undefined {
  const data = readJson(path.join(home, RECEIPT));
  if (!isRecord(data)) return undefined;
  return { label: str(data.label), owner: Number(data.owner) || 0 };
}

/** A label no account uses yet: the wanted one, or it with 2, 3... appended. */
export function uniqueLabel(registry: Registry, wanted: string): string {
  for (let n = 1; ; n++) {
    const label = n === 1 ? wanted : `${wanted} ${n}`;
    if (!find(registry, label)) return label;
  }
}

/**
 * Reserve an account's final home and prepare it for a sign-in. The sign-in
 * happens in place: on macOS a login is keyed by its home's path, so the
 * home can never move afterwards.
 */
export function beginLogin(provider: Provider, label: string): string {
  mkdirPrivate(homesRoot(provider.id));
  return withLock(lockPath(provider.id), () => {
    const registry = load(provider);
    const home = path.join(homesRoot(provider.id), uniqueId(provider, registry, label || "account"));
    try {
      mkdirPrivate(home);
      writeReceipt(home, { label, owner: process.pid });
      linkShared(provider, home);
    } catch (error) {
      fs.rmSync(home, { recursive: true, force: true });
      throw error;
    }
    return home;
  });
}

function duplicateMessage(existing: Account, email: string): string {
  const who = email ? `${existing.label} (${email})` : existing.label;
  return `That's ${who}, which is already added. Try again and sign in as the other account in the private window.`;
}

/**
 * Register a home a sign-in just finished in. A duplicate or unfinished login
 * is removed. The receipt stays until the registry is saved, so a crash in
 * between is finished by `recover`.
 */
export function registerLogin(provider: Provider, home: string, label: string): Account {
  const resolved = path.resolve(home);
  if (!isInside(resolved, homesRoot(provider.id)) || !readReceipt(resolved)) {
    throw new AccountError(`${home} is not a ${provider.name} sign-in in progress.`);
  }
  const found = provider.identity(resolved);
  if (!found.accountId || !provider.signedIn(resolved)) {
    removeHome(provider, resolved);
    throw new AccountError("The sign-in didn't finish, so no account was added.");
  }
  return withLock(lockPath(provider.id), () => {
    const registry = load(provider);
    refreshIdentities(provider, registry);
    const existing = registry.accounts.find((a) => a.accountId === found.accountId);
    if (existing) {
      removeHome(provider, resolved);
      throw new AccountError(duplicateMessage(existing, found.email));
    }
    const name = uniqueLabel(registry, label.trim() || found.email.split("@")[0] || "Account");
    provider.carrySettings(resolved);
    const entry: Account = { id: path.basename(resolved), label: name, home: resolved, primary: false, ...found };
    registry.accounts.push(entry);
    save(provider, registry);
    fs.rmSync(path.join(resolved, RECEIPT), { force: true });
    return entry;
  });
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
 * Finish what an interrupted `add` left behind: a home whose sign-in completed
 * but was never registered is registered, and one that never got a login is
 * removed. Sign-ins whose `add` is still running are left to it.
 */
export function recover(provider: Provider): Account[] {
  const recovered: Account[] = [];
  const root = homesRoot(provider.id);
  if (!fs.existsSync(root)) return recovered;
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const home = path.join(root, name);
    const receipt = readReceipt(home);
    if (!receipt) continue;
    if (receipt.owner !== process.pid && processAlive(receipt.owner)) continue;
    if (load(provider).accounts.some((a) => a.id === name)) {
      fs.rmSync(path.join(home, RECEIPT), { force: true });
      continue;
    }
    try {
      recovered.push(registerLogin(provider, home, receipt.label));
    } catch {
      // registerLogin removed a duplicate or unfinished sign-in.
    }
  }
  recoverLegacyPending(provider, recovered);
  return recovered;
}

/** v0.1 signed in under .pending/ and moved the home afterwards (Linux only). */
function recoverLegacyPending(provider: Provider, recovered: Account[]): void {
  const pending = pendingRoot(provider.id);
  if (!fs.existsSync(pending)) return;
  for (const name of fs.readdirSync(pending)) {
    const old = path.join(pending, name);
    const owner = Number(readRecord(path.join(old, RECEIPT)).owner) || 0;
    if (processAlive(owner) && owner !== process.pid) continue;
    if (provider.signedIn(old) && provider.identity(old).accountId) {
      const label = str(readRecord(path.join(old, RECEIPT)).label);
      const id = uniqueId(provider, load(provider), label || "account");
      const home = path.join(homesRoot(provider.id), id);
      fs.renameSync(old, home);
      writeReceipt(home, { label, owner: process.pid });
      try {
        recovered.push(registerLogin(provider, home, label));
      } catch {
        // duplicate: already cleaned up
      }
    } else {
      fs.rmSync(old, { recursive: true, force: true });
    }
  }
  try {
    fs.rmdirSync(pending);
  } catch {
    // not empty: a live sign-in
  }
}

/**
 * Register a home that is already signed in, where it is. Nothing is copied:
 * two homes holding one login would share a rotating refresh token, and the
 * first refresh would sign the other out.
 */
export function adopt(provider: Provider, dir: string, label: string): Account {
  const home = fs.realpathSync(path.resolve(dir.replace(/^~(?=$|[\\/])/, userHome())));
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
export function repairLinks(provider: Provider, registry: Registry): string[] {
  const unshared = new Set<string>();
  for (const account of registry.accounts) {
    if (!account.primary && fs.existsSync(account.home)) for (const name of linkShared(provider, account.home)) unshared.add(name);
  }
  return [...unshared];
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
    // Only a home agent-switch made is deleted; an adopted one stays.
    const deletedHome = isInside(home, homesRoot(provider.id));
    if (deletedHome) removeHome(provider, home);
    registry.accounts = registry.accounts.filter((a) => a.id !== account.id);
    if (registry.active === account.id) registry.active = registry.accounts[0]!.id;
    registry.alert = "";
    return { account, deletedHome };
  });
}
