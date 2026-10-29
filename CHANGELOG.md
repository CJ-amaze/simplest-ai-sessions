# Changelog

## 0.5.4

- Exclude Codex app-server, maintenance and MCP/exec services from session cards.
- Associate shared-daemon rollouts with real clients using an unambiguous launch-time match or explicit resume ID. Keep multiple rollouts instead of discarding the entire daemon when more than one conversation is open. Ambiguous clients remain unlinked.
- Remove a Codex card when its client exits, even while the daemon or shell remains alive. Rediscover unchanged rollouts when a client resumes them.
- Read Codex 0.165 typed user/final messages and track active turns on the client card.
- Prevent inspected empty clients and new processes from claiming unrelated old sessions by working directory. Avoid routing unidentified or unknown-PID hooks to another session.
- Serialize startup and interval scans/events, reject obsolete mapping results before updating any session state, and bound ps/lsof subprocess time.
- Always typecheck and rebuild before packaging, and synchronize package/lockfile versions.

Shared-daemon client association remains heuristic; see README for unsupported ambiguous launch and in-TUI switching cases.
