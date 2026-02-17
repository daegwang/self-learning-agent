# self-learning-agent (slagent)

A CLI tool that watches your coding AI agents, learns from every session, and automatically improves their instruction files over time.

Supports: **Claude Code** · **Codex**

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   OBSERVE    │     │   ANALYZE    │     │    APPLY     │
│              │     │              │     │              │
│ Watch agent  │ ──▶ │ AI reviews   │ ──▶ │ Update       │
│ sessions     │     │ the session  │     │ CLAUDE.md /  │
│ passively    │     │ for patterns │     │ AGENTS.md    │
└──────────────┘     └──────────────┘     └──────────────┘
```

1. **Observe** — Polls agent log directories (`~/.claude/projects/`, `~/.codex/sessions/`) to record file edits, commands, test results, and user interventions
2. **Analyze** — On `/review`, sends session events to an AI that identifies failure patterns, bad habits, and missing instructions
3. **Apply** — Approved suggestions are written directly into your agent's instruction files (`CLAUDE.md`, `AGENTS.md`) with automatic backup

## Installation

```bash
npm install -g self-learning-agent
```

Or from source:

```bash
git clone https://github.com/daegwang/self-learning-agent.git
cd self-learning-agent
npm install
npm run build
npm link
```

## Usage

```bash
slagent
```

Starts the watcher and interactive REPL:

```
  ╭─────────────────────────────────╮
  │  self-learning-agent (slagent)  │
  │  v0.1.0                         │
  ╰─────────────────────────────────╯

  overview  ● claude · 2 learnings (global)
              · ~/workspace/my-project · 5 events ● running
              · ~/workspace/other-project · 1 learning (project)
            ○ codex

  ⚡ 1 unreviewed run found — run /review to review

  Commands:
    /review      Review an agent run for improvements
    /learnings   List current learnings
    /setup       Configure settings
    /overview    Show agents & learnings overview
    /help        Show this help
    /exit        Quit
```

### Commands

| Command | Description |
|---------|-------------|
| `/review` | Select an agent run to analyze — approve, reject, or toggle scope on each suggestion |
| `/learnings` | Browse all learnings with status, agent, scope, and target path |
| `/setup` | Arrow-key menu to choose the review agent (`auto`, `claude`, `codex`) |
| `/overview` | Refresh the dashboard showing agents, sessions, and learnings |
| `/help` | Show available commands |
| `/exit` | Quit |

## Review Flow

When you run `/review`:

1. Pick from active or recent agent sessions
2. The session's events are sent to an AI for analysis
3. Each suggestion shows: target file, action, confidence, rationale, and content
4. You choose per suggestion: **approve**, **reject**, **skip**, or **toggle** scope (global ↔ project)
5. Approved learnings are written to instruction files with automatic backup

## Storage

All data lives in `~/.slagent/` (global, not per-project):

```
~/.slagent/
├── config.json           # Settings (review agent, privacy, retention)
├── events/
│   └── <sessionId>.jsonl # Recorded agent events (file edits, commands, tests)
├── sessions/
│   └── <sessionId>.json  # Session metadata (agent, outcome, files changed)
├── rules/
│   └── rules.json        # All learnings (proposed, approved, applied, rejected)
└── backups/
    └── <ts>-<path>       # Pre-modification backups of instruction files
```

## Configuration

Edit `~/.slagent/config.json` or use `/setup`:

```json
{
  "analysis": {
    "agent": "auto",
    "tokenBudget": 8000,
    "timeoutMs": 120000,
    "minConfidence": 0.6
  },
  "privacy": {
    "redactSecrets": true,
    "excludePaths": ["node_modules", ".env", ".env.local"]
  },
  "retention": {
    "maxAgeDays": 90
  }
}
```

| Setting | Description |
|---------|-------------|
| `analysis.agent` | Which agent runs reviews: `auto` (session's own agent), `claude`, or `codex` |
| `analysis.tokenBudget` | Max tokens for the analysis prompt context |
| `analysis.minConfidence` | Minimum confidence threshold for suggestions (0–1) |
| `privacy.redactSecrets` | Redact API keys, tokens, and credentials from analysis |
| `retention.maxAgeDays` | Auto-prune session data older than this |

## License

MIT
