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
- **Click a card → focus its terminal.** The card for the currently active terminal is highlighted.
- **Cards = live processes.** Dead sessions, resume leftovers, and bootstrap ghosts never show. A freshly opened `codex` that hasn't received its first query yet shows as a placeholder card.
- **`＋ New Terminal` button** at the bottom of the sidebar to start your next session.
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

On first run it offers to install **hooks** (a Claude Code `Stop`/`Notification` hook and a codex `notify` entry) so approval-waiting and turn boundaries are detected precisely, plus an optional **statusLine** entry that lets cards show each Claude session's effort level (only added if you don't already have a statusLine). Existing settings are preserved and backed up (`*.agent-monitor.bak`); `AI Sessions: Remove hooks` cleanly removes only its own entries. Without hooks it still works in a degraded mode (30-second activity window, no approval detection for Claude).

## Requirements

- **macOS** (uses `ps`/`lsof`; Linux likely portable but untested, Windows not supported — PRs welcome)
- **VS Code ≥ 1.100**
- **Claude Code** and/or **Codex CLI** — any plan; the extension itself needs no credentials

## How it works

Three local signal sources, reconciled every few seconds:

1. **Transcript tailing** — `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl` are tailed incrementally (256 KB bootstrap window). Model, topic, tokens, turn boundaries, and per-line timestamps come from here.
2. **Process reconciliation** — `ps` snapshots map live `claude`/`codex` processes to sessions (native session files → hook-verified pid → stored pid → launch-cwd heuristic → singleton pairing) and enforce the invariant *cards = live processes*.
3. **Hook events** — the installed hooks append one JSON line per event to `~/.vscode-agent-monitor/events.jsonl` (locally). This is how `Stop`, permission requests, and idle notifications are detected the moment they happen.

On recent Claude Code versions (2.1.20x+), Claude Code's own per-session state files provide busy/idle directly and take precedence over inference.

Diagnostics: Output panel → **AI Sessions** channel (heartbeat + errors).

## Status semantics

| Status | Meaning |
|---|---|
| `● Working` | A turn is open — the agent is doing something, even if the transcript is silent (long build, remote MCP call, extended thinking) |
| `⚠ Needs approval` | Waiting on a permission prompt — your input unblocks it |
| `○ Idle` | The prompt is yours — you can type a command right now |
| `✕ Exited` | Process ended — card dims, then disappears after 5 minutes |

## Privacy

Everything stays on your machine. The extension never makes network requests. Hook scripts write event metadata (session id, event kind, timestamp) to a local file only.

## Development

```bash
npm test          # vitest (140+ tests)
npm run typecheck
npm run build     # esbuild bundle
npm run package   # vsce → .vsix
```

Note: parts of the code comments are currently in Korean (the project's original working language). Contributions — including translations, Linux support, and Windows support — are welcome.

## License

[MIT](LICENSE)
