# agent-switch design

agent-switch lets one machine run Claude Code on several subscriptions. It
picks which account a session starts as, shows every account's limits, and
moves new sessions to an account with room before the active one runs out.

The design follows Omarchy 4.5's agent accounts, which proved it out, but
nothing here depends on Omarchy.

## Principles

1. **Choose at launch, never mid-flight.** An account is picked when a
   session starts and stays for that session's life. agent-switch is a
   launcher, not an HTTP proxy: it never sits between Claude Code and
   Anthropic, never rewrites requests, and never spreads one session across
   accounts. Running sessions are never touched by a switch.
2. **Only Claude Code refreshes tokens.** OAuth refresh tokens rotate. If two
   programs refresh the same login, one of them ends up holding a dead token.
   agent-switch reads tokens to ask about limits, and never writes them.
3. **Tokens stay where Claude Code put them.** The registry stores
   display-safe identity only (id, label, email, org, plan). Credentials stay
   in each account's own home with the permissions Claude Code gave them.
4. **One setup, many logins.** Every account shares the primary home's
   history, projects, settings, skills, hooks, plugins and CLAUDE.md through
   symlinks. Only the login differs.
5. **Fail soft.** A failed limits check keeps the last good numbers and says
   how old they are. A broken cache or registry entry is repaired, not fatal.
   `claude` must always start, even when agent-switch can't decide anything.

## Layout

```
~/.claude/                     primary account ("main"), untouched
~/.claude.json                 primary account file, untouched
$XDG_STATE_HOME/agent-switch/  (default ~/.local/state/agent-switch)
  claude.json                  registry: accounts, active, mode, threshold
  claude.lock                  registry lock
  claude/<id>/                 an added account's home
    .credentials.json          its own login (real file)
    .claude.json               its own account file (real file)
    projects -> ~/.claude/projects        and every other shared entry
  claude/.pending/login-*/     a sign-in in progress
  cache/claude-<id>.json       last good limits per account
```

`AGENT_SWITCH_STATE_DIR` moves the state root, and tests use it.

## Registry

```json
{
  "version": 1,
  "active": "main",
  "switch": "manual",
  "threshold": 95,
  "alert": "",
  "accounts": [
    { "id": "main", "label": "Main", "home": "", "primary": true,
      "accountId": "...", "email": "...", "org": "...", "plan": "Max 5x" },
    { "id": "personal", "label": "Personal", "home": "/.../claude/personal",
      "primary": false, "accountId": "...", "email": "...", "plan": "Pro" }
  ]
}
```

Every read normalizes it: unknown fields are dropped, the primary account is
always present, `active` always names a real account, and the threshold is
clamped to 50 to 100. Writes go through a lock file and an atomic rename.

## Launching

`agent-switch run [args]`, or the `claude` shell function that
`agent-switch shell-init` prints:

1. If `CLAUDE_CONFIG_DIR` is already set, respect it and launch directly.
2. Read the registry. Refresh limits if the cache is older than five minutes,
   with a short timeout, and apply the switching policy.
3. Set `CLAUDE_CONFIG_DIR` to the active account's home. The primary account
   leaves it unset, because Claude Code's implicit default is also what
   selects `~/.claude.json`.
4. Set `OMARCHY_AGENT_CLAUDE_HOME` to the same value, so Omarchy's own
   `claude` wrapper, if present, keeps our choice instead of applying its own.
5. Spawn the real `claude` binary with inherited stdio, forward signals, and
   exit with its exit code.

If any step before the spawn throws, it prints one warning line and launches
`claude` as the primary account.

## Adding an account

`agent-switch add [label]`:

1. If `~/.claude` isn't signed in, sign in there first with `claude auth login`.
2. Otherwise create a pending home, lay the shared links, and copy MCP
   servers, folder trust and onboarding keys from `~/.claude.json`.
3. Run `claude auth login` with `CLAUDE_CONFIG_DIR` set to the pending home
   and `BROWSER` set to a private-window launcher. Without that, the browser
   silently reuses the account it is already signed in to.
4. Read who signed in. Refuse a duplicate of an existing account. Move the
   home into place and save the registry. A receipt file lets an interrupted
   registration be recovered on the next `add`.

`agent-switch adopt <dir> [label]` registers an existing signed-in home in
place, without copying credentials. Copying would leave two homes sharing one
rotating refresh token. `agent-switch import omarchy` adopts every Omarchy
Claude account.

## Limits

`GET https://api.anthropic.com/api/oauth/usage` with the account's access
token and `anthropic-beta: oauth-2025-04-20`, the same endpoint Claude Code's
`/usage` reads. Its `limits` array gives every window (session, weekly, and
model-scoped weekly windows) with its percent and reset time. Older answers
fall back to `five_hour` and `seven_day`.

Results are cached per account, and every answer is recorded with when it
was measured. An expired access token can't be refreshed by us (principle 2),
so that account keeps its last numbers and is marked stale. A window whose
reset time has passed counts as empty, stale or not.

## Switching policy

This is a pure function of the registry, per-account limits and the time:

- An account's level is its fullest window that hasn't reset yet.
- Nothing happens until the active account reaches the threshold.
- Then the candidates are the other accounts below it. Accounts more than 15
  points under the threshold come first, then fresh numbers before stale
  ones, then the lowest level, then the soonest reset.
- In `manual` mode, print which account to switch to. In `auto` mode, make
  it active and say so.
- If every account is over the threshold and all their numbers are known,
  say when the first one frees up.
- The last message is remembered in `alert`, so it isn't repeated on every
  launch.

## Milestones

1. Scaffold, design, CI
2. Registry, account homes, `add`, `list`, `use`, `rename`, `remove`, `adopt`, `import`
3. `run` and `shell-init`
4. Limits: `status`, `refresh`, caching
5. Switching policy, `mode`, desktop notifications
6. `doctor`, README, v0.1.0
7. Later: macOS (Keychain-stored credentials), more agents (Codex, Grok, ...)

## Platform notes

Linux stores Claude Code's login in `<home>/.credentials.json`, and that is
what v0.1 supports. macOS keeps it in the Keychain under a service name
derived from the config directory. That needs its own reader, so for now
`doctor` reports macOS as unsupported.
