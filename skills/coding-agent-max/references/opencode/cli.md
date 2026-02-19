# OpenCode CLI Reference

Complete reference for OpenCode CLI — the primary coding agent for this skill.

**Full docs (Load this only if you need to):** https://opencode.ai/docs

## Contents

- Non-interactive mode (`run`)
- Session management
- Background execution (`serve` + `attach`)
- Model and agent selection
- Permissions via `opencode.json`
- Project initialization

---

## Non-Interactive Mode (`run`)

Use `opencode run` to execute prompts without launching the TUI:

```bash
opencode run "Your prompt here"
```

This is the primary way to use OpenCode for automation and scripting.

### Flags

| Flag         | Short | Description                                       |
| ------------ | ----- | ------------------------------------------------- |
| `--continue` | `-c`  | Continue the last session                         |
| `--session`  | `-s`  | Resume specific session by ID                     |
| `--model`    | `-m`  | Model in `provider/model` format                  |
| `--agent`    |       | Agent to use (build, plan, or custom)             |
| `--file`     | `-f`  | Attach file(s) to message                         |
| `--format`   |       | Output format: `default` or `json`                |
| `--title`    |       | Title for the session                             |
| `--share`    |       | Share the session                                 |
| `--attach`   |       | Attach to running server (see Background section) |

### Examples

```bash
# Quick one-shot task
opencode run "Add error handling to src/api.ts"

# Continue last session
opencode run -c "Now add tests for that"

# Resume specific session
opencode run -s abc123 "Continue from here"

# Use specific model
opencode run -m anthropic/claude-opus-4-5 "Complex refactor task"

# Attach file context
opencode run -f src/schema.ts "Update this schema to add user roles"

# JSON output for parsing
opencode run --format json "List all functions in src/"
```

---

## Session Management

OpenCode persists sessions automatically. Use these commands to manage them:

```bash
# List all sessions
opencode session list
opencode session list -n 10  # Last 10 sessions
opencode session list --format json  # JSON output

# Export session to JSON
opencode export <sessionID>

# Import session from file or URL
opencode import session.json
opencode import https://opncd.ai/s/abc123
```

### Session Continuation Pattern

For long-running background tasks, capture the session ID so the orchestrator can resume later:

```bash
# Start a task and note the session (visible in output or via session list)
opencode run "Build the authentication module"

# Later, continue that session
opencode run -s <sessionID> "Now add password reset flow"

# Or just continue the most recent session
opencode run -c "Follow up on the previous task"
```

---

## Model Configuration

OpenCode remembers the last used model. Set a persistent default in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "github-copilot/claude-opus-4-5"
}
```

**Model format:** `provider/model` (e.g., `github-copilot/claude-opus-4-5`, `openai/gpt-5.2-codex`)

### Primary and Fallback Models

| Priority | Provider         | Model             | When to Use                                       |
| -------- | ---------------- | ----------------- | ------------------------------------------------- |
| 1        | `github-copilot` | `claude-opus-4-5` | **Default** — use unless user specifies otherwise |
| 2        | `openai`         | `gpt-5.2-codex`   | Fallback with `--variant xhigh`                   |

**If the user doesn't specify a model, always use `github-copilot/claude-opus-4-5`.**

### Variants (OpenAI Reasoning Models)

OpenAI reasoning models support a `--variant` flag to control reasoning effort:

| Variant  | Description                |
| -------- | -------------------------- |
| `low`    | Minimal reasoning, fastest |
| `medium` | Balanced                   |
| `high`   | More thorough reasoning    |
| `xhigh`  | Maximum reasoning effort   |

```bash
# Use xhigh variant for complex tasks
opencode run -m openai/gpt-5.2-codex --variant xhigh "Complex refactor"
```

### List Available Models

```bash
# List all available models
opencode models

# Filter by provider
opencode models github-copilot
opencode models openai

# Refresh model cache from models.dev
opencode models --refresh

# Verbose output with variants & capabilities
opencode models --verbose
opencode models --verbose openai  # Provider-specific details
```

### Override Per-Command

```bash
opencode run -m github-copilot/claude-opus-4-5 "Your prompt"
opencode run -m openai/gpt-5.2-codex --variant xhigh "Complex reasoning task"
```

### Model Loading Priority

1. `--model` / `-m` CLI flag
2. `model` in `opencode.json`
3. Last used model
4. First available model by internal priority

---

## Background Execution

For long-running tasks, use `serve` mode with `attach` to avoid blocking:

### Start a Headless Server

```bash
# Start server (runs in background)
opencode serve --port 4096

# With authentication
OPENCODE_SERVER_PASSWORD=secret opencode serve --port 4096
```

### Run Commands Against the Server

```bash
# Attach to running server for commands (avoids MCP cold boot on each run)
opencode run --attach http://localhost:4096 "Your prompt here"

# Or attach TUI to the server
opencode attach http://localhost:4096
```

### Background Pattern with PTY

When using bash background mode with OpenCode (for interactive scenarios):

```bash
# Start OpenCode in background with PTY for interactive features
bash pty:true workdir:~/project background:true command:"opencode"

# Monitor with process tools
process action:log sessionId:XXX
process action:poll sessionId:XXX
```

**Note:** Unlike Codex, OpenCode's `run` command is already non-interactive and doesn't require PTY for simple tasks. Use PTY when you need the full TUI or interactive features.

---

## Model and Agent Selection

### Models

```bash
# Specify model
opencode run -m anthropic/claude-sonnet-4-5 "Task"
opencode run -m openai/gpt-4o "Task"

# List available models
opencode models
opencode models anthropic  # Filter by provider
opencode models --refresh  # Update cache
```

### Agents

OpenCode has built-in agents:

- **build** — Full tool access, default for development
- **plan** — Read-only, for analysis and planning

```bash
# Use plan agent for analysis (no file modifications)
opencode run --agent plan "Review this codebase architecture"

# Use build agent (default) for implementation
opencode run --agent build "Implement the feature"

# List available agents
opencode agent list
```

---

## Permissions via `opencode.json`

Control what OpenCode can do via project-level configuration. Place `opencode.json` in your project root:

### Recommended Safe Defaults

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": {
      "*": "allow",
      "rm -rf *": "deny",
      "rm -r *": "deny",
      "git push *": "ask",
      "git commit *": "allow"
    },
    "external_directory": "deny",
    "doom_loop": "ask"
  }
}
```

### Permission Actions

| Action    | Behavior             |
| --------- | -------------------- |
| `"allow"` | Run without approval |
| `"ask"`   | Prompt for approval  |
| `"deny"`  | Block the action     |

### Key Permissions

| Permission           | What it controls                             |
| -------------------- | -------------------------------------------- |
| `edit`               | File modifications (edit, write, patch)      |
| `bash`               | Shell command execution                      |
| `external_directory` | Access outside project root                  |
| `doom_loop`          | Repeated identical tool calls                |
| `read`               | File reading (default: allow, except `.env`) |

### Granular Bash Rules

```json
{
  "permission": {
    "bash": {
      "*": "ask",
      "git *": "allow",
      "npm *": "allow",
      "pnpm *": "allow",
      "grep *": "allow",
      "cat *": "allow",
      "rm *": "deny"
    }
  }
}
```

Rules are evaluated in order; **last matching rule wins**. Put catch-all `"*"` first.

---

## Project Initialization

For new projects without an `AGENTS.md` file, run:

```bash
opencode
# Then in the TUI:
/init
```

Or programmatically via the TUI. This scans the project and generates an `AGENTS.md` file that helps OpenCode understand the codebase structure.

**When to run `opencode init`:**

- New projects with no `AGENTS.md`
- Projects without `.github/copilot-instructions.md`
- After major restructuring

The generated `AGENTS.md` should be committed to Git.

---

## Escalation Pattern

When OpenCode hits a permission wall (e.g., needs to access external directory), it should:

1. **Wait for interactive approval** if running in TUI mode
2. **Notify the orchestrator** if running headless:

```bash
openclaw gateway wake --text "Need permission: <describe what's needed>" --mode now
```

Include this instruction in your prompts for background tasks:

```
If you hit a permission error or need access outside this directory,
run: openclaw gateway wake --text "Need permission: <details>" --mode now
```

---

## Codex → OpenCode Mapping

| Codex                    | OpenCode                                |
| ------------------------ | --------------------------------------- |
| `codex exec "prompt"`    | `opencode run "prompt"`                 |
| `codex exec --full-auto` | Use permissive `opencode.json`          |
| `codex --yolo`           | `"permission": "allow"` in config       |
| `codex review`           | `opencode run --agent plan "Review..."` |

**Key difference:** OpenCode doesn't require a git repository. It works in any directory.

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

# WITH variable expansion
opencode run <<EOF
Fix the bug described here: $BUG_DESCRIPTION
The relevant file is: $TARGET_FILE
EOF
```

**Use `<<'EOF'`** (single quotes) for literal text, no shell interpretation.
**Use `<<EOF`** (no quotes) when you need variables like `$VAR` to expand.

---

## Auto-Notify on Completion

For long-running background tasks, append a wake trigger:

```bash
opencode run <<'EOF'
Build a REST API for todos.

When completely finished, run:
openclaw gateway wake --text "Done: Built todos REST API with CRUD endpoints" --mode now
EOF
```

This triggers an immediate wake event instead of waiting for the next heartbeat.
