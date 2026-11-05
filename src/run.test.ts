import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { claude } from "./claude.js";
import { beginLogin, registerLogin } from "./homes.js";
import { launchTarget } from "./session.js";
import { load, use } from "./registry.js";
import { fakeLogin, sandbox } from "./test-helpers.js";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
let home: string;
let fakeClaude: string;

beforeEach(() => {
  home = sandbox();
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  const pending = beginLogin(claude, "Personal");
  fakeLogin(pending, { accountId: "uuid-personal", email: "me@home.com" });
  registerLogin(claude, pending, "Personal");
  // A stand-in `claude` that reports what it was started with.
  const bin = path.join(home, "bin");
  fs.mkdirSync(path.join(bin, "node_modules", "fake"), { recursive: true });
  const script = path.join(bin, "node_modules", "fake", "cli.js");
  fs.writeFileSync(
    script,
    `const e = process.env;
console.log("home=" + (e.CLAUDE_CONFIG_DIR ?? "unset") + " pin=" + (e.OMARCHY_AGENT_CLAUDE_HOME ?? "unset") + " account=" + (e.AGENT_SWITCH_ACCOUNT ?? "") + " args=" + process.argv.slice(2).join(" "));
process.exit(Number(e.FAKE_EXIT || 0));
`,
  );
  if (process.platform === "win32") {
    // The shape npm writes for a global CLI.
    fakeClaude = path.join(bin, "claude.cmd");
    fs.writeFileSync(fakeClaude, `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\cli.js" %*\r\n`);
  } else {
    fakeClaude = path.join(bin, "claude");
    fs.writeFileSync(fakeClaude, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
});

function testPath(): string {
  const system = process.platform === "win32" ? (process.env.Path ?? process.env.PATH ?? "") : "/usr/bin:/bin";
  return `${path.dirname(fakeClaude)}${path.delimiter}${system}`;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const base = { ...process.env };
  // The suite may itself run inside a Claude session or Omarchy's wrapper.
  for (const key of ["CLAUDE_CONFIG_DIR", "OMARCHY_AGENT_CLAUDE_HOME", "AGENT_SWITCH_ACCOUNT"]) delete base[key];
  delete base.Path;
  const result = spawnSync(process.execPath, [CLI, "run", ...args], {
    env: { ...base, PATH: testPath(), AGENT_SWITCH_NO_CHECK: "1", AGENT_SWITCH_NO_NOTIFY: "1", ...env },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

test("run starts Main with no config dir and pins Omarchy's wrapper to it", () => {
  const { status, out } = run(["--", "--resume", "-p", "hi"]);
  assert.equal(status, 0);
  assert.equal(out, "home=unset pin= account=main args=--resume -p hi");
});

test("run starts the active added account in its own home", () => {
  use(claude, "personal");
  const home = load(claude).accounts[1]!.home;
  assert.equal(run([]).out, `home=${home} pin=${home} account=personal args=`);
});

test("--as picks an account for one launch without changing the active one", () => {
  const home = load(claude).accounts[1]!.home;
  assert.equal(run(["--as", "personal", "--", "x"]).out, `home=${home} pin=${home} account=personal args=x`);
  assert.equal(load(claude).active, "main");
  assert.equal(run(["--as", "nobody"]).status, 1);
});

test("claude flags pass through untouched even without --", () => {
  assert.match(run(["--model", "opus", "--help"]).out, /args=--model opus --help$/);
});

test("a session started inside another keeps its parent's account", () => {
  use(claude, "personal");
  assert.match(run([], { AGENT_SWITCH_ACCOUNT: "main" }).out, /^home=unset .*account=main/);
});

test("a CLAUDE_CONFIG_DIR set by hand is respected", () => {
  const custom = path.join(home, "custom");
  assert.equal(run([], { CLAUDE_CONFIG_DIR: custom }).out.split(" pin=")[0], `home=${custom}`);
  assert.match(run([], { CLAUDE_CONFIG_DIR: custom }).out, / pin=unset /);
});

test("the child's exit code comes back", () => {
  assert.equal(run([], { FAKE_EXIT: "3" }).status, 3);
});

test("a broken registry still starts Claude", () => {
  fs.writeFileSync(path.join(process.env.AGENT_SWITCH_STATE_DIR!, "claude.json"), "{garbage");
  const { status, out } = run([]);
  assert.equal(status, 0);
  assert.match(out, /account=main/);
});

test("launchTarget prefers explicit, then inherited, then external, then active", () => {
  const registry = load(claude);
  assert.equal(launchTarget(claude, registry, "personal", {}).kind, "account");
  assert.deepEqual(launchTarget(claude, registry, undefined, { CLAUDE_CONFIG_DIR: "/x" }), { kind: "external" });
  const inherited = launchTarget(claude, registry, undefined, { CLAUDE_CONFIG_DIR: "/x", AGENT_SWITCH_ACCOUNT: "personal" });
  assert.ok(inherited.kind === "account" && inherited.reason === "inherited");
});

test("a missing claude binary exits 127 with a clear message", () => {
  const result = spawnSync(process.execPath, [CLI, "run"], {
    env: { ...process.env, PATH: path.join(home, "nonexistent"), Path: path.join(home, "nonexistent"), AGENT_SWITCH_NO_CHECK: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /isn't on your PATH/);
});

test("one Ctrl+C reaches Claude once, and a TERM to the wrapper is passed on", { skip: process.platform === "win32" }, async () => {
  const { spawn } = await import("node:child_process");
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh\nn=0\ntrap 'n=$((n+1))' INT\ntrap 'echo "ints=$n"; exit 0' TERM\necho ready\nwhile :; do sleep 0.05; done\n`,
    { mode: 0o755 },
  );
  const base = { ...process.env };
  for (const key of ["CLAUDE_CONFIG_DIR", "OMARCHY_AGENT_CLAUDE_HOME", "AGENT_SWITCH_ACCOUNT"]) delete base[key];
  // Its own process group, like a foreground job in a terminal.
  const wrapper = spawn(process.execPath, [CLI, "run"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...base, PATH: testPath(), AGENT_SWITCH_NO_CHECK: "1" },
  });
  let out = "";
  wrapper.stdout.on("data", (chunk) => (out += chunk));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !out.includes("ready"); i++) await wait(20);
  assert.ok(out.includes("ready"), "fake claude started");
  process.kill(-wrapper.pid!, "SIGINT"); // what the terminal does on Ctrl+C
  await wait(300);
  assert.equal(wrapper.exitCode, null, "the wrapper survives Ctrl+C");
  wrapper.kill("SIGTERM"); // to the wrapper alone
  const code = await new Promise<number | null>((r) => wrapper.on("exit", (c) => r(c)));
  assert.match(out, /ints=1\b/);
  assert.equal(code, 0);
});
