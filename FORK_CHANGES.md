# Fork Differences vs upstream `v2026.3.13-1`

Generated on 2026-03-19.

## Baseline

- Upstream release tag used as the comparison point: `v2026.3.13-1` (`23d5d24b32`, tagged 2026-03-14).
- Fork-only rebased commit count reviewed: `81`.

## Method

This branch diverged before `v2026.3.13-1`, and it has since been rebased onto that tag.
To keep this useful, this file is based on:

1. the rebased fork-only commits after `v2026.3.13-1`
2. the current branch state after requested resets/rollbacks
3. deduping repeated or superseded commits into behavior-level differences

So this is intentionally a "what is different in this fork right now" inventory, not a raw line-by-line diff.

## Differences

### 1. Browser tool grew a real inspect/runtime layer

- Added browser inspect support plus a persistent JavaScript REPL runtime for agents.
- This is not just a prompt tweak; it adds new runtime/tooling capability in `src/agents/tools/browser-tool.ts`, `src/agents/tools/js-repl-tool.ts`, `src/agents/tools/js-repl-worker.ts`, `src/agents/tools/browser-tool.session-state.ts`, `skills/browser/SKILL.md`, and `skills/browser-interactive/SKILL.md`.
- Main evidence: `a8a217a0d5`.

### 2. Browser execution became more fault-tolerant

- Added retries for transient Playwright and gateway failures, improved timeout classification, softened retry guidance, and suppressed a benign browser dialog race rejection.
- Default screenshots were also kept viewport-scoped instead of expanding unexpectedly.
- Main evidence: `4e2f44eee8`, `19e2df5fa3`, `64edb30db3`, `daa17f8cf2`, `ae55e0aa6d`.
- Key files: `src/browser/client-fetch.ts`, `src/browser/cdp.ts`, `src/infra/unhandled-rejections.ts`.

### 3. Screenshot and image delivery got higher-fidelity handling

- Browser screenshots can now switch to document uploads when that preserves fidelity better, instead of always going through image-first delivery.
- Telegram and WhatsApp now have configurable auto-document thresholds for large or awkward images, including browser-specific thresholds like `browserMaxSide` and `browserMaxPixels`.
- Main evidence: `4ad570ce40`, `94a98dd3d8`.
- Key files: `src/media/browser-screenshot.ts`, `src/telegram/send.ts`, `src/web/outbound.ts`, `src/config/types.telegram.ts`, `src/config/types.whatsapp.ts`.

### 4. Outbound media local roots are now configurable

- Added configurable `messages.mediaLocalRoots` so outbound attachments can be allowed from explicit local paths instead of only baked-in defaults.
- This includes agent/workspace-aware local-root handling in outbound send flow.
- Main evidence: `958e997775`.
- Key files: `src/config/types.messages.ts`, `src/media/local-roots.ts`, `src/infra/outbound/outbound-send-service.ts`.

### 5. Continue-guard and stop-reason handling were hardened

- The runner now preserves pre-guard reply text better, suppresses bad guard partials, requires a stop-reason tag, and enforces finalized Telegram replies more strictly.
- Continue-guard retries were made configurable through `agents.defaults.continueGuardRetries`, including disabling them with `0`.
- Main evidence: `64dea1a5a0`, `97c62fe6af`, `6300ec25b5`, `c0ed9da95f`, `0749df929f`.
- Key files: `src/agents/pi-embedded-runner/run.ts`, `src/agents/stop-reason.ts`, `src/agents/system-prompt.ts`, `src/config/types.agent-defaults.ts`.

### 6. The system prompt itself changed in meaningful ways

- The prompt now explicitly requires better progress-update behavior during multi-step work instead of only allowing silent tool use.
- It teaches the agent to end tool-less turns with an `OPENCLAW_STOP_REASON` marker when enabled, and that prompt guidance is tied to the continue-guard configuration.
- It now explicitly tells the agent that browser screenshots and other tool-generated media are not auto-attached to replies and must be sent via the `message` tool when needed.
- It also tells the agent not to narrate ack-only reactions and advertises the new browser/`js_repl` capabilities directly in the prompt/tool summaries.
- Main evidence: `97c62fe6af`, `c0ed9da95f`, `e0755bc24d`, `d538bd2e50`, `a8a217a0d5`.
- Key files: `src/agents/system-prompt.ts`, `src/agents/system-prompt.test.ts`, `src/auto-reply/reply/commands-system-prompt.ts`, `src/agents/pi-embedded-runner/system-prompt.ts`.

### 7. Model retry behavior changed materially before fallback

- Added per-model retry backoff and retry notices.
- Added better handling for Codex server failures and overloaded model failures.
- Changed model behavior so retries happen before falling back to the next model.
- Main evidence: `ee3edbf55d`, `817e9ab635`, `fb1abf5608`, `6014810f0b`, `f6d99f8772`.
- Key files: `src/agents/model-fallback.ts`, `src/config/types.agent-defaults.ts`, `src/config/sessions/transcript.ts`.

### 8. Telegram queueing and command sync got much more robust

- Fixed queued updates being dropped after control-lane activity.
- Added retries and a larger retry window for native command menu sync.
- Fixed reset fallout and improved invalid reaction tool guidance.
- Main evidence: `1873004139`, `2b5c092319`, `4df1a90e48`, `3732402fbc`, `60057d0094`.
- Key files: `src/telegram/bot.ts`, `src/telegram/bot-native-command-menu.ts`, `src/agents/tools/telegram-actions.ts`.

### 9. `/usage` now defaults to provider quota style reporting

- Changed `/usage` to default to provider quota reporting and improved how command/tool-call usage is formatted.
- This is a user-visible output change, not just an internal refactor.
- Main evidence: `5729ad2c5f`, `1667e45b9f`.
- Key files: `src/auto-reply/reply/commands-session.ts`, `src/infra/provider-usage.fetch.codex.ts`, `src/infra/provider-usage.format.ts`.

### 10. Added a standalone local agent chat editor

- New script for browsing/editing agent chat transcripts and sessions locally.
- Exposed as the `agent-chat-editor` package script.
- Main evidence: `463e94306e`.
- Key files: `scripts/agent-chat-editor.ts`, `package.json`.

### 11. Control UI now shows raw tool call/output detail better

- The UI can show raw tool-call arguments and tool output in the sidebar with better wrapping and preview behavior.
- This makes debugging agent/tool interactions easier than the stock summarized card view alone.
- Main evidence: `88d473e997`.
- Key files: `ui/src/ui/chat/tool-cards.ts`, `ui/src/ui/chat/tool-helpers.ts`, `ui/src/styles/chat/sidebar.css`.

### 12. Gateway `--force` got safer against stale processes

- The fork hardened forced gateway startup/shutdown behavior so stale processes and locked ports are handled more aggressively and predictably.
- Main evidence: `1d69a4482e`.
- Key files: `src/cli/gateway-cli/run.ts`, `src/cli/ports.ts`, `src/infra/gateway-lock.ts`.

### 13. WhatsApp initial connect ETIMEDOUT is retried

- Fixed the case where an initial WhatsApp connection timeout would cause the channel to exit instead of retrying with reconnect backoff.
- Main evidence: `6a18f25649`.
- Key file: `src/web/auto-reply/monitor.ts`.

### 14. Heartbeat session rotation recovery was restored

- Heartbeat runs now restore rotated ack-only sessions more reliably.
- Main evidence: `f72f99082d`.
- Key file: `src/infra/heartbeat-runner.ts`.

### 15. Docker/dev runtime is customized well beyond upstream defaults

- Added non-root npm global installs for skills.
- Added Homebrew support in the container.
- Added CodexBar installation, Brave, `openssh-client`, `nano`, extra Bun/Node dependencies, Playwright cache persistence, and a Synology-oriented override with mounted SSH/git/Brave/download locations.
- Main evidence: `038b7669c6`, `7adf6cc954`, `53624e36fe`, `2206c9dcec`, `7d0ea6da41`, `1a98bafa2e`, `c68bcea4fd`, `9588bdecb8`, `5562ae5bd6`, `a3ea099b40`, `b614488544`, `d9995bdd70`, `05e9c57e66`.
- Key files: `Dockerfile`, `docker-compose.yml`, `docker-compose.override.yml`.

### 16. Added a fork-specific cloud-init/VPS bootstrap path

- Introduced `cloud-init.yaml` for a prebuilt VPS bootstrap flow tailored to this fork.
- Includes OpenClaw setup, Tailscale-oriented host bootstrapping, and RustDesk installation/configuration.
- Main evidence: `9e95d67886`, `4d4ba8e1bb`, `b70ab3365c`, `90d8c27c73`, `ea73c4aa76`, `e15764cefa`.
- Key file: `cloud-init.yaml`.

### 17. The local skill surface expanded substantially

- Added a large pack of local workflow skills that are not part of stock upstream here, including:
  - `skills/av-media`
  - `skills/azure-devops-boards`
  - `skills/bird`
  - `skills/browser`
  - `skills/browser-interactive`
  - `skills/candidate-screening`
  - `skills/coding-agent-max`
  - `skills/company-recordings-cli`
  - `skills/doc`
  - `skills/indeed-candidates-graphql`
  - `skills/local-places`
  - `skills/multi-coding-agent`
  - `skills/pdf-form-filler`
  - `skills/quickbooks`
  - `skills/spreadsheet`
  - `skills/video-download`
- Main evidence: `8fd4aeb771`, `2d19408c2d`, `e595499e3c`, `d135c904bd`, `0814c24585`, `466c4564ce`, `cb7a398327`, `8fa009c5c0`, `64613f4ae3`, `a8a217a0d5`.

### 18. Google automation changed from legacy watcher flow to `gws`

- Replaced the `gog` skill with `gws`.
- Removed the legacy Gmail watcher setup/run flow and now treats Gmail webhook ingestion as an external ingestor concern rather than an in-repo watcher lifecycle.
- The CLI now explicitly fails `openclaw webhooks gmail setup/run` with a removal message.
- Main evidence: `8864049070`.
- Key files: `skills/gws/SKILL.md`, `src/cli/webhooks-cli.ts`, `src/hooks/gmail-watcher.ts`.

### 19. The fork intentionally diverges from upstream maintenance workflow

- Removed most upstream GitHub Actions workflows from the fork.
- Removed the `scripts/committer` helper and its docs guidance.
- Added a repo-local Codex `upstream-release-sync` prompt for maintaining the fork.
- Main evidence: `817607761d`, `a180ae65f3`, `e78a5235f0`, `bab37e738a`.
- Key files: `.github/workflows/*`, `.codex/prompts/upstream-release-sync.md`.

### 20. Tool-media delivery changed

- Browser tool media is no longer auto-delivered like a normal reply payload.
- Main evidence: `648dffc1f4`.
- Key file: `src/agents/pi-embedded-subscribe.handlers.tools.ts`.

### 21. Reply/output sanitization got stricter

- The fork suppresses leaked heartbeat acknowledgements and leaked `OPENCLAW_STOP_REASON` markers from user-visible replies.
- Main evidence: `98f43d80dc`.
- Key files: `src/auto-reply/reply/normalize-reply.ts`, `src/auto-reply/reply/reply-utils.test.ts`, `src/agents/pi-embedded-runner/run/payloads.ts`.

### 22. WhatsApp auto-document gating changed for browser docs

- In WhatsApp auto mode, browser-generated document uploads are gated by size-only browser thresholds instead of the broader image heuristics.
- Main evidence: `dd8a2b9747`.
- Key files: `src/web/outbound.ts`, `src/web/outbound.test.ts`.

## Notes

- This file reflects the current rebased branch state, including the requested rollbacks of the old delivery/finalization experiments, the steer-per-message queue change, the non-streaming steer injection change, and the removed sanitizer/Codex-SSE items.
- Some early Docker/Homebrew/CodexBar commits appear in more than one iteration in history; they are intentionally collapsed here into one behavior-level change.
