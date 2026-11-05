import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJson, withLock, writeJsonAtomic, LockTimeoutError } from "./fsutil.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "asw-fs-"));
}

test("writeJsonAtomic writes private files and leaves no temp files", () => {
  const dir = tmpdir();
  const file = path.join(dir, "nested", "a.json");
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(readJson(file), { a: 2 });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["a.json"]);
});

test("readJson returns undefined for missing and corrupt files", () => {
  const dir = tmpdir();
  assert.equal(readJson(path.join(dir, "missing.json")), undefined);
  fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.equal(readJson(path.join(dir, "bad.json")), undefined);
});

test("withLock releases the lock after success and after a throw", () => {
  const lock = path.join(tmpdir(), "x.lock");
  assert.equal(withLock(lock, () => 42), 42);
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => withLock(lock, () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(lock), false);
});

test("withLock takes over a lock whose owner is dead", () => {
  const lock = path.join(tmpdir(), "x.lock");
  fs.writeFileSync(lock, "999999999");
  assert.equal(withLock(lock, () => "ok", { timeoutMs: 500 }), "ok");
});

test("withLock times out on a live owner", () => {
  const lock = path.join(tmpdir(), "x.lock");
  fs.writeFileSync(lock, String(process.ppid));
  assert.throws(() => withLock(lock, () => 1, { timeoutMs: 100 }), LockTimeoutError);
});
