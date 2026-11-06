import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { claude } from "./claude.js";
import {
  connectEditors,
  currentWrapper,
  disconnectEditors,
  editorStatus,
  parseJsonc,
  SETTING,
  withoutWrapper,
  withWrapper,
  wrapperPath,
} from "./editors.js";
import { beginLogin, registerLogin } from "./homes.js";
import { use } from "./registry.js";
import { fakeLogin, sandbox } from "./test-helpers.js";

const posix = process.platform !== "win32";
const W = "/state/bin/claude-editor-wrapper";
let home: string;

beforeEach(() => {
  home = sandbox();
});

// ------------------------------------------------------------ settings.json

test("the wrapper setting is added to settings.json without disturbing it", () => {
  const cases = [
    "",
    "{}",
    "{\n}\n",
    '{\n  // my font\n  "editor.fontSize": 14\n}\n',
    '{\n  "editor.fontSize": 14,\n}\n',
    '{\n  "a": { "b": [1, 2] }\n}',
    '{\n  /* a } brace in a comment */\n  "x": "a } brace in a string"\n}',
    '{\n\t"tabs": true\n}',
  ];
  for (const text of cases) {
    const next = withWrapper(text, W);
    assert.ok(next, `edited: ${JSON.stringify(text)}`);
    assert.equal(currentWrapper(next!), W);
    const before = text.trim() ? (parseJsonc(text) as Record<string, unknown>) : {};
    const after = parseJsonc(next!) as Record<string, unknown>;
    assert.deepEqual({ ...after, [SETTING]: undefined }, { ...before, [SETTING]: undefined }, "nothing else changed");
  }
  assert.match(withWrapper('{\n  // my font\n  "editor.fontSize": 14\n}\n', W)!, /\/\/ my font/, "comments survive");
  assert.match(withWrapper('{\n\t"tabs": true\n}', W)!, /\n\t"claudeCode/, "indentation is matched");
});

test("an existing wrapper value is replaced in place", () => {
  const next = withWrapper(`{\n  "${SETTING}": "/old",\n  "z": 1\n}`, W)!;
  assert.equal(currentWrapper(next), W);
  assert.match(next, /"z": 1/);
});

test("a settings file that isn't an object is left alone", () => {
  assert.equal(withWrapper("[1, 2]", W), undefined);
  assert.equal(withWrapper("{ broken", W), undefined);
});

test("removing the setting keeps the file valid", () => {
  for (const text of ['{\n  "a": 1\n}\n', "{}", '{\n  // keep me\n  "a": 1,\n}']) {
    const back = withoutWrapper(withWrapper(text, W)!);
    assert.equal(currentWrapper(back), undefined);
    assert.deepEqual(parseJsonc(back), text.trim() === "{}" ? {} : { a: 1 });
  }
  assert.match(withoutWrapper(withWrapper('{\n  // keep me\n  "a": 1\n}', W)!), /keep me/);
});

// ------------------------------------------------------------ connecting

/** Where this OS keeps an editor's settings (the layout agent-switch looks in). */
function editorDir(folder: string): string {
  const base = process.platform === "darwin" ? path.join(home, "Library", "Application Support") : path.join(home, ".config");
  const dir = path.join(base, folder, "User");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("setup connects every installed VS Code-family editor, once", { skip: !posix }, () => {
  const code = editorDir("Code");
  fs.writeFileSync(path.join(code, "settings.json"), '{\n  // mine\n  "editor.fontSize": 14\n}\n');
  editorDir("Cursor"); // installed, no settings yet
  const result = connectEditors();
  assert.deepEqual(result.connected.sort(), ["Cursor", "VS Code"]);
  assert.equal(currentWrapper(fs.readFileSync(path.join(code, "settings.json"), "utf8")), wrapperPath());
  assert.ok(fs.existsSync(path.join(code, "settings.json.agent-switch-backup")), "the original was backed up");
  assert.ok(fs.statSync(wrapperPath()).mode & 0o111, "the wrapper is executable");
  assert.deepEqual(connectEditors().already.sort(), ["Cursor", "VS Code"]);
  assert.ok(editorStatus().every((e) => e.connected));
});

test("an editor with its own wrapper is skipped, and undo only removes ours", { skip: !posix }, () => {
  const code = editorDir("Code");
  fs.writeFileSync(path.join(code, "settings.json"), `{ "${SETTING}": "/my/wrapper" }`);
  const cursor = editorDir("Cursor");
  const result = connectEditors();
  assert.deepEqual(result.connected, ["Cursor"]);
  assert.match(result.skipped[0]!.reason, /its own wrapper/);
  assert.deepEqual(disconnectEditors(), ["Cursor"]);
  assert.equal(currentWrapper(fs.readFileSync(path.join(code, "settings.json"), "utf8")), "/my/wrapper");
  assert.equal(currentWrapper(fs.readFileSync(path.join(cursor, "settings.json"), "utf8")), undefined);
  assert.equal(fs.existsSync(wrapperPath()), false);
});

test("macOS editors live under Application Support", () => {
  process.env.AGENT_SWITCH_PLATFORM = "darwin";
  const dir = path.join(home, "Library", "Application Support", "Code", "User");
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(editorStatus().map((e) => e.settingsFile), [path.join(dir, "settings.json")]);
});

test("Windows editors aren't touched (the extension can't run a script wrapper there)", () => {
  process.env.AGENT_SWITCH_PLATFORM = "win32";
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  fs.mkdirSync(path.join(home, "AppData", "Roaming", "Code", "User"), { recursive: true });
  assert.deepEqual(connectEditors(), { connected: [], already: [], skipped: [] });
});

// ------------------------------------------------------------ the wrapper itself

/** A stand-in for the editor's bundled claude: reports how it was started. */
function fakeBundledClaude(): string {
  const file = path.join(home, "bundled-claude");
  fs.writeFileSync(
    file,
    `#!/bin/sh\ntrap 'echo got-int; exit 130' INT\necho "home=\${CLAUDE_CONFIG_DIR-unset} args=$*"\n[ "$1" = "--wait" ] && { echo ready; while :; do sleep 0.05; done; }\nexit 7\n`,
    { mode: 0o755 },
  );
  return file;
}

function setUpAccounts(): string {
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  const pending = beginLogin(claude, "Personal");
  fakeLogin(pending, { accountId: "uuid-personal", email: "me@home.com" });
  return registerLogin(claude, pending, "Personal").home;
}

const cleanEnv = () => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_SWITCH_NO_CHECK: "1", AGENT_SWITCH_NO_NOTIFY: "1" };
  for (const key of ["CLAUDE_CONFIG_DIR", "OMARCHY_AGENT_CLAUDE_HOME", "AGENT_SWITCH_ACCOUNT"]) delete env[key];
  return env;
};

test("the wrapper starts the editor's claude as the active account, saying nothing", { skip: !posix }, () => {
  const personal = setUpAccounts();
  use(claude, "personal");
  editorDir("Code");
  connectEditors();
  const result = spawnSync(wrapperPath(), [fakeBundledClaude(), "--output-format", "stream-json", "a b"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(result.stdout, `home=${personal} args=--output-format stream-json a b\n`, "stdout is Claude's alone");
  assert.equal(result.status, 7, "Claude's exit code comes back");
});

test("if agent-switch is uninstalled, the wrapper still starts Claude", { skip: !posix }, () => {
  setUpAccounts();
  editorDir("Code");
  connectEditors();
  const script = fs.readFileSync(wrapperPath(), "utf8").replace(/^cli=.*$/m, "cli='/nonexistent/agent-switch'");
  fs.writeFileSync(wrapperPath(), script);
  const result = spawnSync(wrapperPath(), [fakeBundledClaude(), "x"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(result.stdout, "home=unset args=x\n");
});

test("an interrupt sent to the wrapper reaches Claude", { skip: !posix }, async () => {
  setUpAccounts();
  editorDir("Code");
  connectEditors();
  const child = spawn(wrapperPath(), [fakeBundledClaude(), "--wait"], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes("ready"); i++) await new Promise((r) => setTimeout(r, 30));
  child.kill("SIGINT"); // to the wrapper alone, as an editor would
  const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  assert.match(out, /got-int/);
  assert.equal(code, 130);
});
