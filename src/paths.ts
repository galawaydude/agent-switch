import * as os from "node:os";
import * as path from "node:path";

export function userHome(): string {
  return process.env.HOME || os.homedir();
}

/** Where agent-switch keeps registries, added homes and caches. */
export function stateRoot(): string {
  if (process.env.AGENT_SWITCH_STATE_DIR) return path.resolve(process.env.AGENT_SWITCH_STATE_DIR);
  const xdg = process.env.XDG_STATE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(userHome(), ".local", "state"), "agent-switch");
}

export function registryPath(provider: string): string {
  return path.join(stateRoot(), `${provider}.json`);
}

export function lockPath(provider: string): string {
  return path.join(stateRoot(), `${provider}.lock`);
}

/** The directory that holds a provider's added account homes. */
export function homesRoot(provider: string): string {
  return path.join(stateRoot(), provider);
}

export function pendingRoot(provider: string): string {
  return path.join(homesRoot(provider), ".pending");
}

export function cachePath(provider: string, accountId: string): string {
  return path.join(stateRoot(), "cache", `${provider}-${accountId}.json`);
}

/** Whether `child` is strictly inside `parent` (after resolving both). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
