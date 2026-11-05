# agent-switch

Run Claude Code on several subscriptions from one machine.

- **Switch accounts per session.** Pick which subscription new `claude` sessions start as. Running sessions are never touched.
- **See every account's limits.** Session, weekly and model-scoped windows, with reset times, for every account at once.
- **Move before you hit the wall.** When the active account nears its limit, agent-switch tells you which account has room, or switches new sessions there for you.
- **One setup.** Every account shares your history, projects, settings, skills, hooks, plugins, MCP servers and `CLAUDE.md`. Only the login differs.

```
$ agent-switch status
Claude · manual switching at 95%

*  Main  Max 5x  me@work.com  ACTIVE
    Session (5h)    █░░░░░░░░░░░░░░░░░░░    6%  resets in 4h 36m
    Weekly          █████████████░░░░░░░   66%  resets in 17h 46m
    Weekly · Fable  ░░░░░░░░░░░░░░░░░░░░    2%  resets in 17h 46m

   Personal  Pro  me@home.com
    Session (5h)  ░░░░░░░░░░░░░░░░░░░░    0%
    Weekly        ░░░░░░░░░░░░░░░░░░░░    0%  resets in 6d 0h
```

## Do you need this?

**On [Omarchy](https://omarchy.org) 4.5 or newer, no.** Omarchy has this built in as *agent accounts* (`omarchy agent account`). It adds a bar panel with live limit meters and covers Codex and Grok as well as Claude. Use that.

agent-switch is the same idea for everywhere else:

- macOS and Windows
- Linux setups that don't run Omarchy
- machines where you want it as a plain CLI, with no desktop integration

Already using Omarchy's accounts and moving to another machine? `agent-switch import omarchy` takes over existing Omarchy logins in place.

## How it works

agent-switch is a launcher, not a proxy. It never sits between Claude Code and Anthropic.

- Your existing `~/.claude` login is the **Main** account and stays exactly where it is.
- Each added account gets its own folder under `~/.local/state/agent-switch/claude/<name>/`. That folder holds only that account's login. Everything else is a symlink back to `~/.claude`.
- `claude` (through a small shell function) starts the real Claude Code with `CLAUDE_CONFIG_DIR` pointed at the account you picked.
- Limits come from the same Anthropic endpoint Claude Code's `/usage` reads, asked with each account's own sign-in.
- agent-switch **never refreshes or copies login tokens**. Only Claude Code does that, so two programs never fight over a rotating refresh token.

The design is borrowed from [Omarchy](https://omarchy.org)'s agent accounts, made standalone. See [docs/DESIGN.md](docs/DESIGN.md) for the details.

## Install

Works on Linux, macOS and Windows. Needs Node 20 or newer and [Claude Code](https://docs.claude.com/claude-code).

```sh
# Homebrew (macOS and Linux)
brew install galawaydude/tap/agent-switch

# or npm, anywhere
npm install -g https://github.com/galawaydude/agent-switch/releases/download/v0.2.0/agent-switch-0.2.0.tgz
```

Then make `claude` go through agent-switch:

```sh
# bash / zsh: ~/.bashrc or ~/.zshrc
eval "$(agent-switch shell-init)"

# fish: ~/.config/fish/config.fish
agent-switch shell-init fish | source

# PowerShell: $PROFILE
agent-switch shell-init powershell | Out-String | Invoke-Expression
```

Check the setup with `agent-switch doctor`.

### Platform notes

| | Logins | Shared setup | Notes |
|---|---|---|---|
| Linux | `.credentials.json` in each account folder | symlinks | |
| macOS | Keychain, one entry per account folder (Claude Code's own scheme) | symlinks | Removing an account also deletes its Keychain entry |
| Windows | `.credentials.json` in each account folder | junctions for folders; symlinks for files | File symlinks need Developer Mode. Without it, `settings.json`, `CLAUDE.md`, `history.jsonl` and `keybindings.json` aren't shared, and `doctor` says so. `remove` can't detect a running session, so quit Claude first |

State lives in `~/.local/state/agent-switch` (or `$XDG_STATE_HOME`), and in `%LOCALAPPDATA%\agent-switch` on Windows.

## Use

```sh
agent-switch add Personal      # sign in to another subscription (opens a private browser window)
agent-switch list              # your accounts; * marks the one new sessions use
agent-switch use personal      # new sessions start as Personal
agent-switch use next          # cycle to the next account
agent-switch status            # limits for every account (--refresh to skip the 5-minute cache)
claude                         # starts as the active account
agent-switch run --as main     # one session as a different account, without switching
```

Accounts can be named by id, name or email. `asw` is a short alias for `agent-switch`.

### Adding an account

`agent-switch add <name>` runs `claude auth login` in a fresh folder and opens the sign-in page in a **private** window. A normal window would quietly reuse the account you're already signed in to. It looks for Chrome, Chromium, Brave, Vivaldi, Edge, Firefox, LibreWolf or Zen, on each platform. To use something else, set `AGENT_SWITCH_BROWSER` to a command that opens a URL privately:

```sh
AGENT_SWITCH_BROWSER="firefox -P throwaway --private-window" agent-switch add Work
```

Don't log out of Claude Code to add an account: logging out revokes the saved sign-in.

If you already use Omarchy's agent accounts, take them over in place with `agent-switch import omarchy`. For any other folder that's already signed in, use `agent-switch adopt <dir> [name]`.

### Switching near a limit

```sh
agent-switch mode manual 95    # default: warn at 95% and say which account has room
agent-switch mode auto 90      # move new sessions to the account with the most room at 90%
```

The check runs when you start `claude`. It reuses numbers from the last 5 minutes and waits at most 3 seconds on the network, so `claude` still starts quickly offline.

Only the active account crossing the threshold triggers anything, so auto mode never flaps back to an account that just reset. Among the accounts with room, it prefers ones not close to their own limit, then ones with fresh numbers, then the emptiest.

To get notified without starting a session, run `check` on a timer:

```sh
# crontab -e
*/10 * * * * agent-switch check --notify --quiet
```

### Expired sign-ins

An account you haven't used for a while has an expired access token. agent-switch won't refresh it (see above), so its numbers show as paused, with their age, until a session runs as it. Running `agent-switch run --as <name>` once wakes it up. If the sign-in itself has lapsed, run `agent-switch login <name>`.

## Commands

| Command | What it does |
|---|---|
| `list [--json]` | Show accounts |
| `add [name]` | Sign in to another subscription |
| `login <account>` | Sign an account in again |
| `use [account\|next]` | Choose the account new sessions use |
| `rename <account> <name>` | Rename an account |
| `remove <account>` | Forget an account (and delete the folder agent-switch made for it) |
| `status [--refresh] [--json]` | Limits for every account |
| `mode [manual\|auto] [threshold]` | How to react near a limit |
| `check [--notify] [--quiet]` | Refresh limits and apply the switching policy |
| `run [--as <account>] [--no-check] [-- args]` | Start Claude Code (what the `claude` function calls) |
| `shell-init [bash\|zsh\|fish\|powershell]` | Print the `claude` shell function |
| `adopt <dir> [name]` | Register an already signed-in config folder |
| `import omarchy` | Adopt Omarchy's agent accounts |
| `doctor` | Check the setup |

## Behaviour worth knowing

- **Running sessions never move.** Switching only affects sessions started afterwards.
- **Nested sessions keep their account.** When Claude Code runs `claude` itself, the child stays on its parent's account.
- **A `CLAUDE_CONFIG_DIR` you set yourself wins.** agent-switch steps aside.
- **`claude` always starts.** If agent-switch can't decide (broken state, no network), it warns and starts Claude Code as usual.
- **Removing is safe.** `remove` refuses an account a running session uses. It deletes only the folder agent-switch created, never the shared files its links point to, and never an adopted folder.
- **Works alongside Omarchy.** Sessions started through agent-switch use agent-switch's choice, even with Omarchy's own `claude` wrapper on your PATH.

## Environment

| Variable | Effect |
|---|---|
| `AGENT_SWITCH_STATE_DIR` | Where registries, account folders and caches live (default `$XDG_STATE_HOME/agent-switch`) |
| `AGENT_SWITCH_BROWSER` | Command that opens a URL in a private window, for `add` and `login` |
| `AGENT_SWITCH_NO_CHECK` | Skip the limit check when launching |
| `AGENT_SWITCH_NO_NOTIFY` | Never send desktop notifications |
| `AGENT_SWITCH_CLAUDE_BIN` | Use this `claude` binary instead of the one on `PATH` |

## Develop

```sh
git clone https://github.com/galawaydude/agent-switch && cd agent-switch
npm install
npm test          # builds, then runs the suite against a sandboxed $HOME
node dist/cli.js help
```

Tests never touch your real `~/.claude`.

## Roadmap

- More agents: Codex, Grok and others that keep their login in a config folder

## License

MIT
