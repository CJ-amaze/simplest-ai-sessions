# Simplest AI Sessions

**The simplest AI session manager for VS Code.**

One sidebar that shows every [Claude Code](https://claude.com/claude-code) and [Codex CLI](https://github.com/openai/codex) session running on your machine — what each one is doing, which one needs your attention, and one click to jump to its terminal.

- **No API keys. No LLM calls. No accounts.** 100% local — it only reads session transcript files and process state that already exist on your machine.
- If you already use Claude Code and/or Codex in a terminal, just install and go.

## What you get

```
┌────────────────────────────────────────┐
│ ● Working   claude-fable-5             │   ← status you can trust
│ max·bypassPermissions · pid 94052      │   ← effort · permission mode · pid
│ Making a video with the MCP tools      │   ← session topic
│ ~/projects/my-app (main)               │   ← cwd + git branch
│ 8.1M tok · ▂▂▂ 39% · $9.26            │   ← tokens · context % · est. cost
└────────────────────────────────────────┘
```

- **Honest statuses.** The rule is simple: *if you can type into the terminal right now, it's `Idle` (or `Needs approval`) — everything else is `Working`.* Long silent tool runs, remote MCP calls, extended thinking: still `Working`. When a turn ends, it drops to `Idle`. On recent Claude Code versions the extension reads Claude Code's own busy/idle state directly.
- **Needs-approval badge.** Sessions waiting on a permission prompt are highlighted, and the sidebar badge counts them — no more discovering an agent has been blocked for 20 minutes.
- **Pinned #1.** `aiSessions.pinnedTerminal` names the terminal that always gets badge #1 and sorts first (your control session); everything else is numbered from 2.
- **Fixed session name.** A session started with `claude -n <name>` shows that name as its own line on the card (the topic line below still follows the latest prompt).
- **Click a card → focus its terminal.** The card for the currently active terminal is highlighted.
- **Cards follow session clients.** Codex server/maintenance processes never get their own cards. Closing a Codex client removes its card on the next process refresh, even if its shared daemon or terminal shell stays alive. An unlinked client shows a placeholder until its session is identified. Claude sessions may remain dimmed for five minutes while their terminal is still open.
- **tmux-aware.** A session running inside tmux maps to the VS Code terminal that holds its tmux client — same `#n` badge, same click-to-focus. A tmux session with no client in this window shows a `tmux:<session>` chip; click it to attach in a new terminal. Turn on `aiSessions.tmuxAutoAttach` to have such terminals opened automatically (and closed when the tmux session ends). Attach terminals that survive a window reload are re-adopted, so they are still closed when their session ends. Badge numbers fill the lowest free slot (an existing badge never moves; `#1` is reserved for `aiSessions.pinnedTerminal`), and a session whose tmux session or terminal is gone drops off the list immediately instead of lingering as `Exited`.
- **Always-on control session (opt-in).** `aiSessions.tmuxEnsure` keeps named tmux sessions alive: when one is missing, its command runs in a new terminal (e.g. a script that does `tmux new-session -A …`). `aiSessions.startupLayout.*` runs a list of commands on window start (close editors, focus this sidebar, …) and focuses a named terminal; `closeIdleTerminals` also closes empty shells left over from an app restart. Put both in workspace settings (or user settings if you use a single window) so only that window does it.
- **Every terminal is visible.** Terminals without an AI session show as compact rows (click to focus) and upgrade to a full card the moment you run `claude`/`codex` in them. A **`＋ New Terminal`** button sits at the bottom to start your next session.
- **Token / context-window / estimated-cost** per session (cost is a reference estimate based on public API list prices; subscription usage differs).

## Install

Grab the `.vsix` from [Releases](https://github.com/CJ-amaze/simplest-ai-sessions/releases) and:

```bash
code --install-extension simplest-ai-sessions-*.vsix
```

Or build from source:

```bash
git clone https://github.com/CJ-amaze/simplest-ai-sessions
cd simplest-ai-sessions
npm install
npm run package        # → simplest-ai-sessions-<version>.vsix
code --install-extension simplest-ai-sessions-*.vsix
```

On first run it offers to install **hooks** (a Claude Code `Stop`/`Notification` hook, a codex `notify` entry, and a codex `PermissionRequest` hook in `~/.codex/hooks.json`) so approval-waiting and turn boundaries are detected precisely, plus an optional **statusLine** entry that lets cards show each Claude session's effort level (only added if you don't already have a statusLine). Existing settings are preserved and backed up (`*.agent-monitor.bak`); `AI Sessions: Remove hooks` cleanly removes only its own entries. Without hooks it still works in a degraded mode (30-second activity window, no approval detection for Claude).

> **codex approval detection requires a one-time trust step**: codex skips non-managed hooks until you review them — open codex and run `/hooks` once to trust the new `PermissionRequest` hook. (codex ≥ 0.144 no longer writes approval requests to the rollout file, so the hook is the only reliable signal.)

## Requirements

- **macOS** (uses `ps`/`lsof`; Linux likely portable but untested, Windows not supported — PRs welcome)
- **VS Code ≥ 1.100**
- **Claude Code** and/or **Codex CLI** — any plan; the extension itself needs no credentials

## How it works

Three local signal sources, reconciled every few seconds:

1. **Transcript tailing** — `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl` are tailed incrementally. Claude uses a 256 KB bootstrap window; Codex streams its initial history to recover model and turn boundaries even during long turns. Model, topic, tokens, turn boundaries, and per-line timestamps come from here.
2. **Process reconciliation** — `ps` snapshots map live `claude`/`codex` clients to sessions (Claude native session files / Codex rollout ownership → hook-verified pid → stored pid → launch-cwd heuristic → singleton pairing). Codex's npm wrapper and native binary share one identity. Direct rollout ownership handles older clients and `codex exec`. For shared-daemon clients in Codex 0.165, the server's rollouts are matched to a unique client launch within 30 seconds or an explicit `codex resume <id>`. The client PID controls terminal focus and card lifetime; the daemon PID never does.
3. **Hook events** — the installed hooks append one JSON line per event to `~/.vscode-agent-monitor/events.jsonl` (locally). This is how `Stop`, permission requests, and idle notifications are detected the moment they happen.

On recent Claude Code versions (2.1.20x+), Claude Code's own per-session state files provide busy/idle directly and take precedence over inference.

Diagnostics: Output panel → **AI Sessions** channel (heartbeat + errors).

Shared-daemon mapping is a conservative heuristic: Codex does not expose a client PID in rollout metadata. Simultaneous launches, an in-TUI `/new` or `/resume`, and resume-by-name/picker can remain unlinked when the evidence is ambiguous. They are not assigned another client's conversation based on working directory alone. Direct-file clients retain their existing exact mapping. Codex 0.165's typed `item_completed` messages are supported for prompt/reply previews, with commentary kept separate from final replies.

## Status semantics

| Status | Meaning |
|---|---|
| `● Working` | A turn is open — the agent is doing something, even if the transcript is silent (long build, remote MCP call, extended thinking) |
| `⚠ Needs approval` | Waiting on a permission prompt — your input unblocks it |
| `○ Idle` | The prompt is yours — you can type a command right now |
| `✕ Exited` | Claude process ended — dims for up to 5 minutes while its container exists. Codex client exit removes the card on the next refresh |

## Privacy

By default, everything stays on your machine. The extension never makes network requests. Hook scripts write event metadata (session id, event kind, timestamp) to a local file.

For a custom Codex completion notification, you can optionally install an executable at
`~/.vscode-agent-monitor/codex-turn-complete.sh`. After logging a completed turn, the hook
runs it in the background with the original Codex notification JSON as its first argument.
That payload can include prompt and reply text; the callback controls what it sends or stores.
No callback is installed by the extension. Claude notifications remain in Claude's own `Stop` hooks.

## Development

```bash
npm test          # vitest
npm run typecheck
npm run build     # esbuild bundle
npm run package   # typecheck + fresh build, then vsce → .vsix
```

Note: parts of the code comments are currently in Korean (the project's original working language). Contributions — including translations, Linux support, and Windows support — are welcome.

## License

[MIT](LICENSE)
