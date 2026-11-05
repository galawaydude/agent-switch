import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "./launch.js";
import { userHome } from "./paths.js";
import { isMac, isWindows } from "./platform.js";

/**
 * Hooking `claude` into the user's shell, so nobody has to edit a startup
 * file by hand. The hook is a marked block, appended (which follows a
 * symlinked dotfile instead of replacing it) and removed by `--undo`. It is
 * guarded, so a shell keeps working if agent-switch is uninstalled.
 */

export type Shell = "zsh" | "bash" | "fish" | "powershell";

const BEGIN = "# >>> agent-switch >>>";
const END = "# <<< agent-switch <<<";
const MARKER = "agent-switch shell-init";

export function currentShell(): Shell {
  if (isWindows() && !process.env.SHELL) return "powershell";
  const name = path.basename(process.env.SHELL || (isMac() ? "zsh" : "bash"));
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  if (name === "pwsh" || name === "powershell") return "powershell";
  return isMac() ? "zsh" : "bash";
}

function powershellProfiles(): string[] {
  const found = new Set<string>();
  for (const exe of ["pwsh", "powershell"]) {
    if (!resolveBinary(exe)) continue;
    const result = spawnSync(exe, ["-NoProfile", "-Command", "$PROFILE.CurrentUserCurrentHost"], { encoding: "utf8", timeout: 15_000 });
    const file = (result.stdout || "").trim();
    if (result.status === 0 && file) found.add(file);
  }
  if (!found.size) {
    const docs = path.join(userHome(), "Documents");
    found.add(path.join(docs, "PowerShell", "Microsoft.PowerShell_profile.ps1"));
    if (isWindows()) found.add(path.join(docs, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"));
  }
  return [...found];
}

/** The startup files a shell reads, in the order we'd write to them. */
export function startupFiles(shell: Shell): string[] {
  const home = userHome();
  switch (shell) {
    case "zsh":
      return [path.join(process.env.ZDOTDIR || home, ".zshrc")];
    case "bash":
      // macOS terminals start login shells, which read .bash_profile.
      return [path.join(home, isMac() ? ".bash_profile" : ".bashrc")];
    case "fish":
      return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "fish", "conf.d", "agent-switch.fish")];
    case "powershell":
      return powershellProfiles();
  }
}

/** Every file a hook might already be in, whichever shell put it there. */
function knownFiles(): string[] {
  const home = userHome();
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    path.join(process.env.ZDOTDIR || home, ".zshrc"),
    path.join(home, ".zprofile"),
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".profile"),
    path.join(config, "fish", "config.fish"),
    path.join(config, "fish", "conf.d", "agent-switch.fish"),
    path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    path.join(config, "powershell", "Microsoft.PowerShell_profile.ps1"),
  ];
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The startup files that already hook `claude` up. */
export function hookedFiles(): string[] {
  return knownFiles().filter((file) => {
    const text = read(file);
    return text.includes(BEGIN) || text.includes(MARKER);
  });
}

export function isHooked(): boolean {
  return hookedFiles().length > 0;
}

/** How the hook calls agent-switch: by name when it's on PATH, else by full path. */
function selfCommand(shell: Shell): string {
  if (resolveBinary("agent-switch")) return "agent-switch";
  const script = fs.realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)));
  return shell === "powershell" ? `& '${process.execPath}' '${script}'` : `'${process.execPath}' '${script}'`;
}

export function hookBlock(shell: Shell): string {
  const self = selfCommand(shell);
  const onPath = self === "agent-switch";
  let body: string;
  if (shell === "fish") {
    body = onPath ? `if type -q agent-switch\n  agent-switch shell-init fish | source\nend` : `${self} shell-init fish | source`;
  } else if (shell === "powershell") {
    body = onPath
      ? `if (Get-Command agent-switch -ErrorAction SilentlyContinue) { agent-switch shell-init powershell | Out-String | Invoke-Expression }`
      : `${self} shell-init powershell | Out-String | Invoke-Expression`;
  } else {
    body = onPath ? `command -v agent-switch >/dev/null 2>&1 && eval "$(agent-switch shell-init)"` : `eval "$(${self} shell-init)"`;
  }
  return `${BEGIN}\n# Makes \`claude\` start as the account you picked. Remove with: agent-switch setup --undo\n${body}\n${END}\n`;
}

export interface SetupResult {
  shell: Shell;
  /** Files the hook was added to just now. */
  added: string[];
  /** Files that already had it. */
  already: string[];
}

export function setup(shell: Shell = currentShell()): SetupResult {
  const result: SetupResult = { shell, added: [], already: hookedFiles() };
  if (result.already.length) return result;
  for (const file of startupFiles(shell)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = read(file);
    const separator = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
    // appendFileSync writes through a symlinked dotfile rather than replacing it.
    fs.appendFileSync(file, separator + hookBlock(shell));
    result.added.push(file);
  }
  return result;
}

/** Take the hook back out of every file it's in. */
export function undo(): string[] {
  const cleaned: string[] = [];
  for (const file of hookedFiles()) {
    const text = read(file);
    // The block plus the blank line setup put before it.
    const pattern = new RegExp(`\\n{0,2}${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`, "g");
    const next = text.replace(pattern, "\n");
    if (next === text) continue; // a hand-written line: leave it to its owner
    if (path.basename(file) === "agent-switch.fish" && !next.trim()) fs.rmSync(file);
    else fs.writeFileSync(file, next.replace(/^\n+/, ""));
    cleaned.push(file);
  }
  return cleaned;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "source ~/.zshrc", or how else to load the hook in an open terminal. */
export function reloadHint(shell: Shell, file: string): string {
  const shown = file.startsWith(userHome()) ? "~" + file.slice(userHome().length) : file;
  if (shell === "powershell") return `. $PROFILE`;
  if (shell === "fish") return `source ${shown}`;
  return `source ${shown}`;
}
