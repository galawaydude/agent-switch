import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readJson } from "./fsutil.js";
import { userHome } from "./paths.js";
import { isMac } from "./platform.js";

/**
 * Where Claude Code keeps a home's login.
 *
 * Linux and Windows: `<home>/.credentials.json`.
 *
 * macOS: a Keychain generic password whose account is the user name and whose
 * service is "Claude Code-credentials", plus "-" and the first 8 hex digits of
 * sha256(config dir) when CLAUDE_CONFIG_DIR is set. So every config dir already
 * gets its own Keychain login, and a home must never move after sign-in: its
 * login is keyed by its path. (Read from Claude Code 2.1.318.)
 */

const SERVICE = "Claude Code-credentials";

export function keychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || os.userInfo().username;
  } catch {
    name = "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

function isPrimaryHome(home: string): boolean {
  return path.resolve(home) === path.resolve(path.join(userHome(), ".claude"));
}

/** The Keychain service holding a home's login. */
export function keychainService(home: string): string {
  if (isPrimaryHome(home)) return SERVICE;
  const hash = createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8);
  return `${SERVICE}-${hash}`;
}

function security(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(process.env.AGENT_SWITCH_SECURITY_BIN || "security", args, {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function readKeychain(home: string): unknown {
  const { status, stdout } = security(["find-generic-password", "-a", keychainAccount(), "-w", "-s", keychainService(home)]);
  if (status !== 0) return undefined;
  const raw = stdout.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Long values can come back hex-encoded.
    if (/^[0-9a-f]+$/i.test(raw)) {
      try {
        return JSON.parse(Buffer.from(raw, "hex").toString("utf8"));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function credentialsFile(home: string): string {
  return path.join(home, ".credentials.json");
}

/** The raw credentials JSON for a home, wherever this platform keeps it. */
export function readCredentials(home: string): Record<string, unknown> {
  if (isMac()) {
    const fromKeychain = readKeychain(home);
    if (isRecord(fromKeychain)) return fromKeychain;
  }
  // Also Claude Code's fallback on macOS when the Keychain is unavailable.
  const fromFile = readJson(credentialsFile(home));
  return isRecord(fromFile) ? fromFile : {};
}

export function hasKeychainEntry(home: string): boolean {
  return isMac() && security(["find-generic-password", "-a", keychainAccount(), "-s", keychainService(home)]).status === 0;
}

/** Remove a home's Keychain login (macOS); a no-op elsewhere. */
export function deleteStoredLogin(home: string): void {
  if (!isMac()) return;
  security(["delete-generic-password", "-a", keychainAccount(), "-s", keychainService(home)]);
}
