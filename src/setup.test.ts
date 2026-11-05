import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hookBlock, isHooked, setup, undo } from "./setup.js";
import { sandbox } from "./test-helpers.js";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const posix = process.platform !== "win32";
let home: string;
let originalPath: string | undefined;

beforeEach(() => {
  home = sandbox();
  originalPath = originalPath ?? process.env.PATH;
  process.env.PATH = originalPath;
});

/** Put a working `agent-switch` command on PATH, as Homebrew or npm would. */
function installOnPath(): string {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, "agent-switch");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  return bin;
}

test("setup adds a guarded hook to .zshrc once, and undo restores the file", { skip: !posix }, () => {
  process.env.SHELL = "/bin/zsh";
  installOnPath();
  const rc = path.join(home, ".zshrc");
  fs.writeFileSync(rc, "export EDITOR=vim");
  const first = setup();
  assert.deepEqual(first.added, [rc]);
  const text = fs.readFileSync(rc, "utf8");
  assert.match(text, /^export EDITOR=vim\n\n# >>> agent-switch >>>/);
  assert.match(text, /command -v agent-switch >\/dev\/null 2>&1 && eval "\$\(agent-switch shell-init\)"/);
  assert.equal(isHooked(), true);
  assert.deepEqual(setup().added, [], "running it again changes nothing");
  assert.equal(fs.readFileSync(rc, "utf8"), text);
  assert.deepEqual(undo(), [rc]);
  assert.equal(fs.readFileSync(rc, "utf8").trim(), "export EDITOR=vim");
  assert.equal(isHooked(), false);
});

test("a symlinked startup file stays a symlink", { skip: !posix }, () => {
  process.env.SHELL = "/bin/zsh";
  const dotfiles = path.join(home, "dotfiles");
  fs.mkdirSync(dotfiles);
  fs.writeFileSync(path.join(dotfiles, "zshrc"), "# mine\n");
  fs.symlinkSync(path.join(dotfiles, "zshrc"), path.join(home, ".zshrc"));
  setup();
  assert.ok(fs.lstatSync(path.join(home, ".zshrc")).isSymbolicLink());
  assert.match(fs.readFileSync(path.join(dotfiles, "zshrc"), "utf8"), /# >>> agent-switch >>>[\s\S]*shell-init/);
  undo();
  assert.ok(fs.lstatSync(path.join(home, ".zshrc")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dotfiles, "zshrc"), "utf8"), "# mine\n");
});

test("fish gets its own conf.d file, which undo deletes", () => {
  process.env.SHELL = "/usr/bin/fish";
  const result = setup();
  const file = path.join(home, ".config", "fish", "conf.d", "agent-switch.fish");
  assert.deepEqual(result.added, [file]);
  assert.match(fs.readFileSync(file, "utf8"), /shell-init fish \| source/);
  undo();
  assert.equal(fs.existsSync(file), false);
});

test("bash on macOS uses .bash_profile, which login shells read", () => {
  process.env.SHELL = "/bin/bash";
  process.env.AGENT_SWITCH_PLATFORM = "darwin";
  assert.deepEqual(setup().added, [path.join(home, ".bash_profile")]);
});

test("a line someone wrote by hand counts as set up, and undo leaves it alone", () => {
  process.env.SHELL = "/bin/bash";
  const rc = path.join(home, ".bashrc");
  fs.writeFileSync(rc, 'eval "$(agent-switch shell-init)"\n');
  assert.equal(isHooked(), true);
  assert.deepEqual(setup().added, []);
  assert.deepEqual(undo(), []);
  assert.equal(fs.readFileSync(rc, "utf8"), 'eval "$(agent-switch shell-init)"\n');
});

test("PowerShell's hook is guarded too", () => {
  installOnPath();
  assert.match(hookBlock("powershell"), /if \(Get-Command agent-switch -ErrorAction SilentlyContinue\)/);
});

test("after setup, a new bash really runs claude through agent-switch", { skip: !posix || !fs.existsSync("/bin/bash") }, () => {
  process.env.SHELL = "/bin/bash";
  process.env.AGENT_SWITCH_PLATFORM = "linux";
  installOnPath();
  setup();
  const check = spawnSync("/bin/bash", ["-c", 'source "$HOME/.bashrc"; type -t claude'], { encoding: "utf8", env: { ...process.env } });
  assert.equal(check.stdout.trim(), "function");
});

test("a hook left behind after uninstalling doesn't break the shell", { skip: !posix || !fs.existsSync("/bin/bash") }, () => {
  process.env.SHELL = "/bin/bash";
  process.env.AGENT_SWITCH_PLATFORM = "linux";
  installOnPath();
  setup();
  fs.rmSync(path.join(home, "bin"), { recursive: true }); // uninstalled
  const check = spawnSync("/bin/bash", ["-c", 'source "$HOME/.bashrc"; echo ok'], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
  assert.equal(check.stdout.trim(), "ok");
  assert.equal(check.stderr, "");
});
