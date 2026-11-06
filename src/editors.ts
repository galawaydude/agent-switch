import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirPrivate } from "./fsutil.js";
import { resolveBinary } from "./launch.js";
import { stateRoot, userHome } from "./paths.js";
import { platform } from "./platform.js";

/**
 * Editors that run Claude Code through Anthropic's VS Code extension (VS Code
 * and its forks). The extension starts its bundled `claude` directly, not
 * through a shell, so the shell hook can't reach it. It does honour the
 * `claudeCode.claudeProcessWrapper` setting: it then runs
 * `<wrapper> <bundled claude> <args...>`. agent-switch points that setting at
 * a small script that runs `agent-switch wrap`, which picks the account and
 * starts the given claude unchanged.
 */

export const SETTING = "claudeCode.claudeProcessWrapper";

const EDITORS: [name: string, folder: string][] = [
  ["VS Code", "Code"],
  ["VS Code Insiders", "Code - Insiders"],
  ["VSCodium", "VSCodium"],
  ["Cursor", "Cursor"],
  ["Windsurf", "Windsurf"],
];

export interface Editor {
  name: string;
  settingsFile: string;
}

function configBase(): string {
  switch (platform()) {
    case "darwin":
      return path.join(userHome(), "Library", "Application Support");
    case "win32":
      return process.env.APPDATA || path.join(userHome(), "AppData", "Roaming");
    default:
      return process.env.XDG_CONFIG_HOME || path.join(userHome(), ".config");
  }
}

/** Editors installed for this user: their User settings folder exists. */
export function installedEditors(): Editor[] {
  const base = configBase();
  return EDITORS.map(([name, folder]) => ({ name, settingsFile: path.join(base, folder, "User", "settings.json") })).filter((e) =>
    fs.existsSync(path.dirname(e.settingsFile)),
  );
}

/** Whether this platform can use the wrapper (Windows can't run a script as one). */
export function editorsSupported(): boolean {
  return platform() !== "win32";
}

// ------------------------------------------------------------- the wrapper

export function wrapperPath(): string {
  return path.join(stateRoot(), "bin", "claude-editor-wrapper");
}

function shq(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Node binaries to try, newest guess first. Editors started from the Dock
 * don't see your shell's PATH, and Homebrew's versioned Cellar path changes
 * on every Node upgrade, so stable `opt` and `bin` links come along too.
 */
function nodeCandidates(): string[] {
  const exec = process.execPath;
  const candidates = [exec];
  const cellar = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(exec);
  if (cellar) candidates.push(`${cellar[1]}/opt/${cellar[2]}/bin/node`, `${cellar[1]}/bin/node`);
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  return [...new Set(candidates)];
}

/** The agent-switch entry to run: the stable PATH link when there is one. */
function cliPath(): string {
  return resolveBinary("agent-switch") ?? fs.realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)));
}

export function wrapperScript(): string {
  const cli = cliPath();
  const lines = [
    "#!/bin/sh",
    "# agent-switch: starts Claude Code in your editor as the account you picked.",
    "# Written by `agent-switch setup`; `agent-switch setup --undo` removes it.",
    `cli=${shq(cli)}`,
    'if [ -e "$cli" ]; then',
    `  for node in ${nodeCandidates().map(shq).join(" ")}; do`,
    '    if [ -x "$node" ]; then exec "$node" "$cli" wrap "$@"; fi',
    "  done",
    "fi",
    "# agent-switch is gone: start Claude as usual.",
    'exec "$@"',
    "",
  ];
  return lines.join("\n");
}

/** Write (or refresh) the wrapper script; returns its path. */
export function writeWrapper(): string {
  const file = wrapperPath();
  mkdirPrivate(path.dirname(file));
  fs.writeFileSync(file, wrapperScript(), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

/** Keep an existing wrapper pointing at the current install (after upgrades). */
export function refreshWrapper(): void {
  try {
    if (fs.existsSync(wrapperPath()) && fs.readFileSync(wrapperPath(), "utf8") !== wrapperScript()) writeWrapper();
  } catch {
    // best effort
  }
}

// ----------------------------------------------------- settings.json edits

interface Scan {
  /** Index of the closing brace of the top-level object. */
  close: number;
  /** Last significant character inside the top-level object. */
  last: string;
}

/** Walk JSON-with-comments, skipping strings and comments. */
function scan(text: string): Scan | undefined {
  let depth = 0;
  let last = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      i = j;
      last = '"';
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return c === "}" ? { close: i, last } : undefined;
    }
    last = c;
  }
  return undefined;
}

/** Parse JSON with comments and trailing commas, the way VS Code does. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1") || "{}");
}

const KEY_PATTERN = new RegExp(`"${SETTING.replace(/\./g, "\\.")}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`);

/** The wrapper an editor is set to use, if any. */
export function currentWrapper(text: string): string | undefined {
  try {
    const value = (parseJsonc(text) as Record<string, unknown>)[SETTING];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Set the wrapper in a settings.json text, keeping comments and layout.
 * Returns the new text, or undefined if the file can't be edited safely.
 */
export function withWrapper(text: string, wrapper: string): string | undefined {
  const value = JSON.stringify(wrapper);
  let next: string;
  if (!text.trim()) {
    next = `{\n  "${SETTING}": ${value}\n}\n`;
  } else if (KEY_PATTERN.test(text)) {
    next = text.replace(KEY_PATTERN, (match, old: string) => match.slice(0, match.length - old.length) + value);
  } else {
    const found = scan(text);
    if (!found) return undefined;
    const before = text.slice(0, found.close).replace(/\s*$/, "");
    const comma = found.last === "{" || found.last === "," || found.last === "" ? "" : ",";
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
    next = `${before}${comma}\n${indent}"${SETTING}": ${value}\n${text.slice(found.close)}`;
  }
  try {
    if (currentWrapper(next) !== wrapper) return undefined;
  } catch {
    return undefined;
  }
  return next;
}

/** Remove the wrapper setting from a settings.json text, keeping the rest. */
export function withoutWrapper(text: string): string {
  const line = new RegExp(`\\n?[ \\t]*"${SETTING.replace(/\./g, "\\.")}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"\\s*,?`);
  let next = text.replace(line, "");
  // A trailing comma left before the closing brace is fine for VS Code, but tidy it.
  next = next.replace(/,(\s*\n?\s*})\s*$/, "$1\n");
  return next;
}

export interface EditorStatus extends Editor {
  connected: boolean;
  /** Set to some other wrapper the user chose; left alone. */
  otherWrapper?: string;
}

export function editorStatus(): EditorStatus[] {
  const ours = wrapperPath();
  return installedEditors().map((editor) => {
    let text = "";
    try {
      text = fs.readFileSync(editor.settingsFile, "utf8");
    } catch {
      // no settings yet
    }
    const wrapper = currentWrapper(text);
    return { ...editor, connected: wrapper === ours && fs.existsSync(ours), otherWrapper: wrapper && wrapper !== ours ? wrapper : undefined };
  });
}

export interface EditorSetup {
  connected: string[];
  already: string[];
  skipped: { name: string; reason: string }[];
}

/** Point every installed VS Code-family editor at the wrapper. */
export function connectEditors(): EditorSetup {
  const result: EditorSetup = { connected: [], already: [], skipped: [] };
  if (!editorsSupported()) return result;
  const editors = editorStatus();
  if (!editors.length) return result;
  const wrapper = writeWrapper();
  for (const editor of editors) {
    if (editor.connected) {
      result.already.push(editor.name);
      continue;
    }
    if (editor.otherWrapper) {
      result.skipped.push({ name: editor.name, reason: `it already uses its own wrapper (${editor.otherWrapper})` });
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(editor.settingsFile, "utf8");
    } catch {
      // created below
    }
    const next = withWrapper(text, wrapper);
    if (next === undefined) {
      result.skipped.push({ name: editor.name, reason: `its settings.json couldn't be edited safely; add "${SETTING}": "${wrapper}" yourself` });
      continue;
    }
    const backup = `${editor.settingsFile}.agent-switch-backup`;
    if (text && !fs.existsSync(backup)) fs.writeFileSync(backup, text);
    fs.writeFileSync(editor.settingsFile, next); // writes through a symlinked settings file
    result.connected.push(editor.name);
  }
  return result;
}

/** Take the wrapper back out of every editor that uses ours. */
export function disconnectEditors(): string[] {
  const done: string[] = [];
  for (const editor of installedEditors()) {
    let text: string;
    try {
      text = fs.readFileSync(editor.settingsFile, "utf8");
    } catch {
      continue;
    }
    if (currentWrapper(text) !== wrapperPath()) continue;
    const next = withoutWrapper(text);
    try {
      parseJsonc(next);
    } catch {
      continue; // leave a file we'd break alone
    }
    fs.writeFileSync(editor.settingsFile, next);
    done.push(editor.name);
  }
  fs.rmSync(wrapperPath(), { force: true });
  return done;
}
