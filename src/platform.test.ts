import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { claude, readOauth } from "./claude.js";
import { keychainAccount, keychainService } from "./credentials.js";
import { beginLogin, linkShared, registerLogin, remove, removeHome } from "./homes.js";
import { commandFor, npmShimTarget, quoteForCmd, resolveBinary } from "./launch.js";
import { browserScriptText } from "./login.js";
import { homesRoot, stateRoot } from "./paths.js";
import { load } from "./registry.js";
import { fakeAccountFile, fakeKeychain, fakeLogin, keychainLogin, sandbox } from "./test-helpers.js";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
// The fake `security` is a .cmd on Windows hosts, which spawnSync can't run.
const keychainTestable = process.platform !== "win32";
let home: string;

beforeEach(() => {
  home = sandbox();
});

// ------------------------------------------------------------------- macOS

test("Keychain service names match Claude Code's", () => {
  assert.equal(keychainService(path.join(home, ".claude")), "Claude Code-credentials");
  const dir = "/Users/me/.local/state/agent-switch/claude/personal";
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  assert.equal(keychainService(dir), `Claude Code-credentials-${hash}`);
  assert.match(keychainAccount(), /^[a-zA-Z0-9._-]+$/);
});

test("on macOS, logins are read from the Keychain entry for each home", { skip: !keychainTestable }, () => {
  process.env.AGENT_SWITCH_PLATFORM = "darwin";
  const store = fakeKeychain();
  fakeAccountFile(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  keychainLogin(store, keychainAccount(), "Claude Code-credentials", { accountId: "uuid-main", email: "me@work.com" });
  assert.equal(claude.signedIn(path.join(home, ".claude")), true);
  assert.equal(claude.identity(path.join(home, ".claude")).plan, "Max 5x");

  const pending = beginLogin(claude, "Personal");
  assert.equal(claude.signedIn(pending), false, "a new home has no login yet");
  fakeAccountFile(pending, { accountId: "uuid-personal", email: "me@home.com" });
  keychainLogin(store, keychainAccount(), keychainService(pending), { accountId: "uuid-personal", email: "me@home.com", accessToken: "tok-p", subscription: "pro", tier: "" });
  const account = registerLogin(claude, pending, "Personal");
  assert.equal(account.plan, "Pro");
  assert.equal(readOauth(account.home)?.accessToken, "tok-p");
  assert.ok(!fs.existsSync(path.join(account.home, ".credentials.json")), "nothing written to disk");

  remove(claude, "personal");
  const left = JSON.parse(fs.readFileSync(store, "utf8"));
  assert.deepEqual(Object.keys(left), [`${keychainAccount()}|Claude Code-credentials`], "the removed home's Keychain login is gone, Main's stays");
});

test("on macOS, a credentials file still works when the Keychain has nothing", { skip: !keychainTestable }, () => {
  process.env.AGENT_SWITCH_PLATFORM = "darwin";
  fakeKeychain();
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  assert.equal(claude.signedIn(path.join(home, ".claude")), true);
});

// ----------------------------------------------------------------- Windows

test("Windows keeps state under LOCALAPPDATA", () => {
  delete process.env.AGENT_SWITCH_STATE_DIR;
  process.env.AGENT_SWITCH_PLATFORM = "win32";
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  assert.equal(stateRoot(), path.join(home, "AppData", "Local", "agent-switch"));
});

test("Windows finds claude.cmd through PATHEXT", () => {
  process.env.AGENT_SWITCH_PLATFORM = "win32";
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\n");
  assert.equal(resolveBinary("claude", bin), path.join(bin, "claude.cmd"));
});

test("an npm .cmd shim is run with Node directly, not through cmd.exe", () => {
  process.env.AGENT_SWITCH_PLATFORM = "win32";
  const bin = path.join(home, "npm");
  const script = path.join(bin, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  const shim = path.join(bin, "claude.cmd");
  fs.writeFileSync(shim, `@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
  assert.equal(npmShimTarget(shim), script);
  assert.deepEqual(commandFor(shim, ["-p", "a & b"]), { file: process.execPath, args: [script, "-p", "a & b"], verbatim: false });
  // Older shims write "%~dp0\..." without the trailing %.
  fs.writeFileSync(shim, `@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
  assert.equal(npmShimTarget(shim), script);
});

test("other batch files go through cmd.exe with every argument escaped", () => {
  process.env.AGENT_SWITCH_PLATFORM = "win32";
  const bat = path.join(home, "claude.bat");
  fs.writeFileSync(bat, "@echo off\r\n");
  const command = commandFor(bat, ["a b", 'say "hi"', "50%"]);
  assert.equal(command.verbatim, true);
  assert.deepEqual(command.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(quoteForCmd("a&b"), '^"a^&b^"');
  assert.equal(quoteForCmd('x"y'), '^"x\\^"y^"');
  assert.equal(quoteForCmd("50%"), '^"50^%^"');
});

test("binaries elsewhere run as they are", () => {
  assert.deepEqual(commandFor("/usr/bin/claude", ["x"]), { file: "/usr/bin/claude", args: ["x"], verbatim: false });
});

test("the private-browser launcher fits each platform", () => {
  const unix = browserScriptText({ name: "firefox", argv: ["/usr/bin/firefox", "--private-window"] }, false);
  assert.equal(unix, `#!/bin/sh\n'/usr/bin/firefox' '--private-window' "$1" >/dev/null 2>&1 &\n`);
  const mac = browserScriptText({ name: "Google Chrome", argv: ["open", "-na", "Google Chrome", "--args", "--incognito"] }, false);
  assert.match(mac, /'open' '-na' 'Google Chrome' '--args' '--incognito' "\$1"/);
  const win = browserScriptText({ name: "Edge", argv: ["C:\\Edge\\msedge.exe", "--inprivate"] }, true);
  assert.equal(win, '@echo off\r\nstart "" "C:\\Edge\\msedge.exe" "--inprivate" "%~1"\r\n');
});

test("removing a home never follows its links into the main setup", () => {
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  const pending = beginLogin(claude, "Personal");
  fs.writeFileSync(path.join(home, ".claude", "projects", "keep.txt"), "x");
  removeHome(claude, pending);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.readFileSync(path.join(home, ".claude", "projects", "keep.txt"), "utf8"), "x");
  assert.throws(() => removeHome(claude, path.join(home, ".claude")), /didn't make it/);
});

test("linkShared reports files Windows wouldn't let it link", { skip: process.platform === "win32" }, () => {
  // Simulate a Windows host without Developer Mode.
  process.env.AGENT_SWITCH_PLATFORM = "win32";
  const dir = path.join(homesRoot("claude"), "x");
  const original = fsDefault.symlinkSync;
  fsDefault.symlinkSync = ((target: fs.PathLike, link: fs.PathLike, type?: fs.symlink.Type | null) => {
    if (type === "file") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return original(target, link, type === "junction" ? "dir" : type);
  }) as typeof fs.symlinkSync;
  syncBuiltinESMExports();
  try {
    const unshared = linkShared(claude, dir);
    assert.deepEqual(unshared.sort(), [...claude.sharedFiles].sort());
    assert.ok(fs.lstatSync(path.join(dir, "projects")).isSymbolicLink());
  } finally {
    fsDefault.symlinkSync = original;
    syncBuiltinESMExports();
  }
});

test("shell-init prints a PowerShell function", () => {
  const result = spawnSync(process.execPath, [CLI, "shell-init", "powershell"], { encoding: "utf8", env: { ...process.env } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^function claude \{ & .+ run -- @args \}$/m);
});

test("the registry survives a round trip on every platform", () => {
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  assert.equal(load(claude).accounts[0]!.email, "me@work.com");
});
