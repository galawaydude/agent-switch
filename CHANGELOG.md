# Changelog

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
