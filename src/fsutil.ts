import * as fs from "node:fs";
import * as path from "node:path";

/** Parse a JSON file, or return undefined when it is missing or unreadable. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRecord(file: string): Record<string, unknown> {
  const value = readJson(file);
  return isRecord(value) ? value : {};
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/**
 * Write a file so that readers only ever see the old or the new contents:
 * write a temporary file beside it, flush it, then rename it over the target.
 */
export function writeFileAtomic(file: string, contents: string, mode = 0o600): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", mode);
}

export function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class LockTimeoutError extends Error {}

/**
 * Hold an exclusive lock file while `fn` runs. The lock holds the owner's
 * pid, so a lock left behind by a crashed process is taken over instead of
 * blocking forever. A lock older than `staleMs` is also treated as abandoned.
 */
export function withLock<T>(lockFile: string, fn: () => T, { timeoutMs = 10_000, staleMs = 60_000 } = {}): T {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      let age = 0;
      try {
        owner = Number.parseInt(fs.readFileSync(lockFile, "utf8"), 10);
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // released between our open and our read
      }
      // A lock with no pid yet is one being written right now, unless it's old.
      const abandoned = Number.isNaN(owner) ? age > 2_000 : !pidAlive(owner) || age > staleMs;
      if (abandoned) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new LockTimeoutError(`Timed out waiting for ${lockFile} (held by pid ${owner})`);
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
}
