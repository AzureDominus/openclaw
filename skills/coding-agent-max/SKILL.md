---
name: coding-agent-max
description: Run OpenCode, Codex CLI, Claude Code, or Gemini CLI via bash for programmatic coding agent control. Use when delegating coding tasks to an AI coding agent, building features, reviewing PRs, or running parallel development workflows.
metadata:
  {
    "openclaw":
      { "emoji": "🧩", "requires": { "anyBins": ["opencode", "codex", "claude", "gemini"] } },
  }
---

# Coding Agent Max

Use coding agents (OpenCode, Codex, Claude Code, Gemini) via bash for delegated development work.

## Fallback Strategy

Use agents in this priority order:

| Priority | Agent           | When to Use                          |
| -------- | --------------- | ------------------------------------ |
| 1        | **OpenCode**    | Default for all coding tasks         |
| 2        | **Codex**       | OpenCode unavailable or usage limits |
| 3        | **Claude Code** | Codex unavailable or usage limits    |
| 4        | **Gemini**      | All above unavailable                |

**Signs to fall back:**

- "You've hit your usage limit"
- Rate limit / 429 errors
- Model overloaded messages

---

## OpenCode Reference

**Full docs (Load this only if you need to):** https://opencode.ai/docs

For CLI usage, read `references/opencode/cli.md`.
For programmatic SDK control (Only read this if you need to write code that controls OpenCode programmatically), read `references/opencode/sdk.md`.

### Default Model

OpenCode remembers the last used model. To set a persistent default, add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "github-copilot/claude-opus-4-5"
}
```

**Model format:** `provider/model` (e.g., `github-copilot/claude-opus-4-5`, `openai/gpt-5.2-codex`)

**If the user doesn't specify a model, always use Opus (`github-copilot/claude-opus-4-5`).**

**Fallback model:** Only if `github-copilot` is unavailable or rate-limited, use:

```bash
opencode run -m openai/gpt-5.2-codex --variant xhigh "Your prompt"
```

**Variants** (OpenAI/Other Provider reasoning models only, GitHub-Copilot doesn't support this): `low`, `medium`, `high`, `xhigh` — controls reasoning effort.

**List available models:**

```bash
opencode models                    # List all
opencode models github-copilot     # Filter by provider
opencode models openai             # Show OpenAI models
opencode models --verbose          # Show variants & capabilities
opencode models --refresh          # Refresh from models.dev
```

**Override per-command:**

```bash
opencode run -m github-copilot/claude-opus-4-5 "Your prompt"
opencode run -m openai/gpt-5.2-codex --variant xhigh "Your prompt"
```

### Quick Start

```bash
# One-shot task (non-interactive, no PTY needed)
opencode run "Add error handling to src/api.ts"

# Continue last session
opencode run -c "Now add tests for that"

# Use specific model
opencode run -m anthropic/claude-sonnet-4-5 "Complex refactor"

# Plan mode (read-only, no modifications)
opencode run --agent plan "Review this architecture"
```

### Background Execution

For long-running tasks, use `serve` + `attach`:

```bash
# Terminal 1: Start headless server
opencode serve --port 4096

# Terminal 2: Run commands against it (fast, no MCP cold boot)
opencode run --attach http://localhost:4096 "Build the feature"
```

Or with bash background mode (when PTY is needed):

```bash
bash pty:true workdir:~/project background:true command:"opencode"
process action:log sessionId:XXX
```

### Session Continuation

```bash
# List recent sessions
opencode session list -n 5

# Resume specific session
opencode run -s <sessionID> "Continue from here"

# Continue most recent
opencode run -c "Follow up"
```

### Project Initialization

For new projects without `AGENTS.md`:

```bash
cd /path/to/project
opencode
# Then run /init in the TUI
```

This generates an `AGENTS.md` file that helps the agent navigate the codebase. Commit it to Git.

### Permissions via opencode.json

OpenCode uses config-based permissions (not CLI flags like Codex's `--yolo`). Create `opencode.json` in project root:

**Safe defaults (recommended):**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": {
      "*": "allow",
      "rm -rf *": "deny",
      "rm -r *": "deny",
      "git push *": "ask"
    },
    "external_directory": "deny",
    "doom_loop": "ask"
  }
}
```

**Full auto (like Codex --full-auto):**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "external_directory": "deny"
  }
}
```

**YOLO mode (like Codex --yolo) — use with caution:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow"
}
```

**Permission values:**

- `"allow"` — Run without approval
- `"ask"` — Prompt for approval
- `"deny"` — Block the action

Key settings:

- `external_directory: deny` — Agent stays in project directory
- `doom_loop: ask` — Catches repeated failing operations
- Granular bash rules block destructive commands

### Escalation Pattern

When agent hits a permission wall, it should:

1. Wait for interactive approval (if TUI), OR
2. Notify orchestrator:

```bash
openclaw gateway wake --text "Need permission: <details>" --mode now
```

---

## Multiline Prompts (Heredoc)

For multiline prompts, use heredoc syntax:

```bash
# No variable expansion (literal text)
opencode run <<'EOF'
Build a REST API for todos with the following requirements:
- CRUD endpoints for /todos
- SQLite database
EOF

# WITH variable expansion (when you need to pass variables)
opencode run <<EOF
Fix the bug described here: $BUG_DESCRIPTION

The relevant file is: $TARGET_FILE
EOF
```

**Use `<<'EOF'`** (single quotes) when you want literal text with no shell interpretation.
**Use `<<EOF`** (no quotes) when you need shell variables like `$VAR` to expand.

---

## ⚠️ PTY Mode (When Needed)

Some scenarios need a pseudo-terminal. Use `pty:true` when:

- Running full TUI mode (not `opencode run`)
- Interactive debugging or REPL
- Agents that need terminal features (Codex, Claude interactive mode)

```bash
# ✅ OpenCode run - no PTY needed
opencode run "Your prompt"

# ✅ OpenCode TUI - PTY recommended
bash pty:true workdir:~/project command:"opencode"

# ✅ Codex always needs PTY
bash pty:true workdir:~/project command:"codex exec 'Your prompt'"
```

---

## Codex CLI (Fallback #2)

**Requires git repository.** Codex won't run outside a trusted git directory.

### Quick Setup for Scratch Work

```bash
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init && codex exec "Your prompt"
```

### Flags

| Flag            | Effect                                        |
| --------------- | --------------------------------------------- |
| `exec "prompt"` | One-shot execution, exits when done           |
| `--full-auto`   | Sandboxed, auto-approves in workspace         |
| `--yolo`        | NO sandbox, NO approvals (fastest, dangerous) |

### Examples

```bash
# One-shot with PTY
bash pty:true workdir:~/project command:"codex exec 'Add dark mode toggle'"

# Full auto (auto-approves changes)
bash pty:true workdir:~/project command:"codex exec --full-auto 'Build REST API'"

# Background for longer work
bash pty:true workdir:~/project background:true command:"codex --yolo 'Refactor auth module'"
```

**Detailed docs:** See `references/claude-code.md` for Claude, `references/gemini-cli.md` for Gemini.

---

## Claude Code (Fallback #3)

| Codex                 | Claude Equivalent                          |
| --------------------- | ------------------------------------------ |
| `codex exec "prompt"` | `claude -p "prompt"`                       |
| `codex --full-auto`   | `claude -p --permission-mode acceptEdits`  |
| `codex --yolo`        | `claude -p --dangerously-skip-permissions` |

```bash
# Non-interactive
claude -p "Add error handling to src/api.ts"

# Interactive with PTY
bash pty:true workdir:~/project command:"claude 'Your task'"
```

---

## Gemini CLI (Fallback #4)

| Codex                 | Gemini Equivalent                  |
| --------------------- | ---------------------------------- |
| `codex exec "prompt"` | `gemini "prompt"`                  |
| `codex --full-auto`   | `gemini --approval-mode auto_edit` |
| `codex --yolo`        | `gemini -y`                        |

```bash
# Non-interactive
gemini "Add error handling to src/api.ts"

# Interactive with PTY
bash pty:true workdir:~/project command:"gemini -i 'Your task'"
```

---

## Parallel Workflows with Git Worktrees

For fixing multiple issues in parallel:

```bash
# Create worktrees
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# Launch agents in each
opencode run "Fix issue #78: <description>" &
# (from /tmp/issue-78)

opencode run "Fix issue #99: <description>" &
# (from /tmp/issue-99)

# Or with Codex (needs PTY)
bash pty:true workdir:/tmp/issue-78 background:true command:"codex --yolo 'Fix issue #78'"
bash pty:true workdir:/tmp/issue-99 background:true command:"codex --yolo 'Fix issue #99'"

# Monitor
process action:list

# Create PRs after
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --title "fix: issue #78" --body "..."

# Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

---

## tmux Orchestration (Advanced)

For advanced multi-agent control, use tmux skill instead of bash background.

### When to Use tmux vs bash background

| Use Case                         | Recommended            |
| -------------------------------- | ---------------------- |
| Quick one-shot                   | `opencode run`         |
| Long-running with monitoring     | `bash background:true` |
| Multiple parallel agents         | **tmux**               |
| Agent forking (context transfer) | **tmux**               |
| Session persistence              | **tmux**               |
| Interactive debugging            | **tmux**               |

### Quick Example

```bash
SOCKET="${TMPDIR:-/tmp}/coding-agents.sock"

# Create sessions
tmux -S "$SOCKET" new-session -d -s agent-1 -c /tmp/worktree-1
tmux -S "$SOCKET" new-session -d -s agent-2 -c /tmp/worktree-2

# Launch agents
tmux -S "$SOCKET" send-keys -t agent-1 "opencode run 'Fix issue #1'" Enter
tmux -S "$SOCKET" send-keys -t agent-2 "opencode run 'Fix issue #2'" Enter

# Monitor
tmux -S "$SOCKET" capture-pane -p -t agent-1 -S -100
```

### Agent Forking (Context Transfer)

Transfer context from one agent to another:

```bash
CONTEXT=$(tmux -S "$SOCKET" capture-pane -p -t planner -S -500)

tmux -S "$SOCKET" new-session -d -s executor
tmux -S "$SOCKET" send-keys -t executor "opencode run <<EOF
Based on this plan: $CONTEXT

Execute step 1.
EOF" Enter
```

---

## ⚠️ Rules

1. **Use OpenCode first** — It's the primary agent, no git-init required
2. **PTY for interactive CLIs** — Codex, Claude interactive mode, Gemini `-i` need PTY
3. **OpenCode `run` doesn't need PTY** — It's already non-interactive
4. **Respect tool choice** — If user asks for Codex, use Codex
5. **Don't hand-code patches** — Let the agent do the work; if it fails, respawn or escalate
6. **Be patient** — Don't kill sessions because they're "slow"
7. **Monitor with process:log** — Check progress without interfering
8. **Parallel is GREAT** — Run multiple agents (in worktrees) for batch work
9. **NEVER start agents in your workspace root** — They'll read soul docs and get weird ideas
10. **NEVER checkout branches in ~/openclaw/** — That's the LIVE OpenClaw instance

---

## Progress Updates (IMPORTANT)

When spawning coding agents in background, you MUST provide progress updates to the USER:

- Send 1 short message when you start (what's running + where)
- Update only when something changes:
  - Milestone completes
  - Agent asks a question / needs input
  - Error or user action needed
  - Agent finishes (what changed + where)
- If you kill a session, immediately say why

---

## Auto-Notify on Completion

For background tasks, append wake trigger to prompts so openclaw (YOU) is notified immediately when done:

```bash
opencode run <<'EOF'
Build a REST API for todos.

When completely finished, run:
openclaw gateway wake --text "Done: Built todos REST API with CRUD endpoints" --mode now
EOF
```

---

## Learnings

- **OpenCode doesn't need git:** Unlike Codex, works in any directory
- **`opencode run` is non-interactive:** No PTY required for simple tasks
- **Session IDs persist:** Use `--session` or `--continue` for multi-turn work
- **`external_directory: deny`:** Smart default keeps agent focused in project
- **`serve` + `attach` pattern:** Avoids MCP cold boot for repeated runs
- **PTY still matters:** Essential for Codex, Claude interactive, and full TUI mode
