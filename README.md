# agent-switch

Use several Claude Code subscriptions on one machine, and switch between them in a click.

- **Switch accounts.** Pick which subscription new `claude` sessions start as.
- **See every account's limits** at a glance, with when they reset.
- **Never hit the wall.** Near a limit, it warns you, or moves new sessions to an account with room.
- **One setup.** All accounts share your history, settings, skills, plugins, MCP servers and `CLAUDE.md`. Only the login differs.

Works on macOS, Linux and Windows.

## Quick start

**1. Install**

```sh
brew install galawaydude/tap/agent-switch
```

No Homebrew? With Node 20+:

```sh
npm install -g https://github.com/galawaydude/agent-switch/releases/download/v0.3.0/agent-switch-0.3.0.tgz
```

You also need [Claude Code](https://docs.claude.com/claude-code), signed in as usual. That login becomes your **Main** account.

**2. Make `claude` use it.** Add one line to your shell's startup file, then open a new terminal:

```sh
echo 'eval "$(agent-switch shell-init)"' >> ~/.zshrc     # macOS (zsh)
echo 'eval "$(agent-switch shell-init)"' >> ~/.bashrc    # Linux (bash)
```

<details>
<summary>fish or PowerShell</summary>

```sh
# fish: add to ~/.config/fish/config.fish
agent-switch shell-init fish | source

# PowerShell: add to $PROFILE
agent-switch shell-init powershell | Out-String | Invoke-Expression
```
</details>

**3. Open it**

```sh
agent-switch ui
```

A page opens in your browser. Click **+ Add account**, give it a name, and sign in to your other subscription in the private window that opens. Then click **Use** on whichever account you want, and `claude` starts as that account from then on.

Something not working? Run `agent-switch doctor`.

## Everyday use

**The page** (`agent-switch ui`) shows every account with its limits. From there you can:
- **Use** an account: new `claude` sessions start as it. Sessions already running stay put.
- **+ Add account**, **Rename**, **Remove**, or **Sign in again** when a login has lapsed.
- Choose **Warn me** or **Switch for me** for when the active account nears its limit, and at what percentage.

Close it with **Stop** at the bottom, or Ctrl+C in the terminal.

**Prefer the terminal?** The same things as commands:

```sh
agent-switch status            # every account's limits
agent-switch use personal      # new sessions start as Personal
agent-switch use next          # cycle to the next account
agent-switch add Work          # sign in to another subscription
agent-switch mode auto 90      # switch automatically at 90%
agent-switch run --as main     # one session as another account, without switching
```

`asw` is a short alias for `agent-switch`. Accounts can be named by id, name or email.

## Good to know

- **Sign in to new accounts in the private window.** A normal window would quietly reuse the account you're already signed in to. If the wrong window opens, use the page's **Open the sign-in page** link in a private window yourself.
- **Don't log out of Claude Code** to add an account. Logging out revokes the saved login.
- **Running sessions never move.** Switching only affects sessions you start afterwards.
- **`claude` always starts.** If agent-switch can't decide (no network, broken state), it warns and starts Claude Code as usual.
- **Paused numbers are normal.** Accounts you haven't used for a while show their last-known limits until a session runs as them: `agent-switch run --as <name>` refreshes them.
- **Your logins stay where Claude Code keeps them**: the Keychain on macOS, and a file in each account's folder elsewhere. agent-switch never copies or refreshes login tokens.

## How it works

agent-switch is a launcher, not a proxy. It never sits between Claude Code and Anthropic.

- Each added account gets its own folder, which holds only its login. Everything else links back to `~/.claude`.
- The `claude` shell function starts the real Claude Code with `CLAUDE_CONFIG_DIR` pointed at the account you picked.
- Limits come from the same Anthropic endpoint Claude Code's `/usage` reads.
- The page is only a display: every click runs an `agent-switch` command. It's reachable only from your own machine, behind a one-time link.

More detail is in [docs/DESIGN.md](docs/DESIGN.md).

## Reference

<details>
<summary>All commands</summary>

| Command | What it does |
|---|---|
| `ui [--port <n>] [--no-open]` | Open the page |
| `status [--refresh] [--json]` | Limits for every account |
| `list [--json]` | Show accounts |
| `use [account\|next]` | Choose the account new sessions use |
| `add [name]` | Sign in to another subscription |
| `login <account>` | Sign an account in again |
| `rename <account> <name>` | Rename an account |
| `remove <account>` | Forget an account and delete its folder |
| `mode [manual\|auto] [threshold]` | Warn or switch automatically near a limit |
| `check [--notify] [--quiet]` | Refresh limits and apply the switching rule (for cron) |
| `run [--as <account>] [-- args]` | Start Claude Code (what the `claude` function calls) |
| `shell-init [bash\|zsh\|fish\|powershell]` | Print the `claude` shell function |
| `adopt <dir> [name]` | Register a config folder that's already signed in |
| `doctor` | Check the setup |

</details>

<details>
<summary>Platform notes</summary>

| | Logins | Shared setup | Notes |
|---|---|---|---|
| macOS | Keychain, one entry per account folder | symlinks | Removing an account also deletes its Keychain entry |
| Linux | `.credentials.json` in each account folder | symlinks | |
| Windows | `.credentials.json` in each account folder | junctions for folders, symlinks for files | File symlinks need Developer Mode; `doctor` says which files aren't shared without it. Quit Claude before removing an account |

State lives in `~/.local/state/agent-switch`, or `%LOCALAPPDATA%\agent-switch` on Windows.

</details>

<details>
<summary>Environment variables</summary>

| Variable | Effect |
|---|---|
| `AGENT_SWITCH_BROWSER` | Command that opens a URL in a private window, for signing in |
| `AGENT_SWITCH_STATE_DIR` | Where account folders and caches live |
| `AGENT_SWITCH_NO_CHECK` | Skip the limit check when starting `claude` |
| `AGENT_SWITCH_NO_NOTIFY` | Never send desktop notifications |
| `AGENT_SWITCH_CLAUDE_BIN` | Use this `claude` binary instead of the one on `PATH` |

</details>

<details>
<summary>Develop</summary>

```sh
git clone https://github.com/galawaydude/agent-switch && cd agent-switch
npm install
npm test          # builds, then runs the tests against a sandboxed home folder
node dist/cli.js help
```

</details>

## Roadmap

- More agents: Codex, Grok and others.

## License

MIT
