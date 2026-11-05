# Changelog

## 0.2.0 (2026-11-05)

Cross-platform: Linux, macOS and Windows.

- macOS: logins are read from the Keychain, where Claude Code keeps one entry per account folder. Removing an account deletes its entry. Running sessions are detected before a remove.
- Windows: junctions for shared folders, PowerShell `shell-init`, npm `claude.cmd` shims run through Node, private-window sign-in with installed browsers. State lives under `%LOCALAPPDATA%`.
- Sign-in now happens in the account's final folder (macOS keys logins by folder path). Interrupted v0.1 sign-ins are still recovered.
- Removing an account unlinks its links before deleting, so it can never reach into `~/.claude`.
- `add` asks for a name when none is given.
- Install with Homebrew: `brew install galawaydude/tap/agent-switch`.

## 0.1.0 (2026-11-05)

First release. Claude Code on Linux.

- Several Claude subscriptions on one machine. Added accounts get their own login and share everything else with `~/.claude`.
- `add` signs in through a private browser window; `login` signs an account in again; `adopt` and `import omarchy` take over existing logins in place.
- `use`, `rename`, `remove`, `list`.
- `run` and `shell-init`: `claude` starts as the active account. Nested sessions keep their parent's account, and a hand-set `CLAUDE_CONFIG_DIR` is respected.
- `status`: every account's session, weekly and model-scoped limits with reset times.
- Switching policy: `manual` warns and names the account with room, `auto` moves new sessions there. `check --notify` runs it from a timer.
- `doctor` checks the whole setup.
- Never refreshes or copies OAuth tokens. All state files are private and written atomically under a lock.
