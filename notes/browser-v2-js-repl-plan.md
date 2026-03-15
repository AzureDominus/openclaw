# Browser V2 + Interactive Patchright Plan

## Summary

- Keep `browser` as a runtime tool. Do not turn it into a skill.
- Add OpenClaw-native skills on top of the tool, not instead of it.
- Add a separate `js_repl` tool for persistent interactive work.
- Keep runtime browser automation on `playwright-core` only, which in this repo resolves to `patchright`.
- Default posture is stealth-first: normal browse/inspect flows avoid diagnostics that may increase detectability.

## Public Interfaces

- Extend `browser` with these tool-level actions: `session_attach`, `session_status`, `session_clear`, `inspect`, `errors`, `requests`, `trace_start`, `trace_stop`, `cookies_get`, `cookies_set`, `cookies_clear`, `storage_get`, `storage_set`, `storage_clear`, `set_offline`, `set_headers`, `set_credentials`, `set_geolocation`, `set_media`, `set_timezone`, `set_locale`, `set_device`.
- Add `js_repl({ code, timeoutMs? })` and `js_repl_reset({})`.
- `session_status` returns `location`, `nodeId?`, `profile`, `targetId`, `title`, `url`, and `cdpUrl`.
- `inspect` defaults to the attached session target, `snapshotFormat="ai"`, `refs="aria"`, and a non-efficient text budget; it returns snapshot text, one sanitized screenshot image, and target metadata.
- `js_repl` exposes `openclaw.cwd`, `openclaw.homeDir`, `openclaw.tmpDir`, `openclaw.tool(name, args?)`, `openclaw.emitImage(imageLike)`, `openclaw.browser.sessionStatus()`, and `openclaw.browser.connect()`. No `codex.*` naming ships in OpenClaw.

## Implementation Changes

- Thread `sessionId` from `createOpenClawTools` into `browser` and `js_repl`; key both per-session registries off `sessionId`, falling back to `agentSessionKey` only when `sessionId` is absent.
- Add an agent-side browser session registry that stores `{ location, nodeId?, profile, targetId?, cdpUrl }` per OpenClaw session. Keep it separate from `profileState.lastTargetId` so multiple agent sessions stop fighting over one global active tab.
- Implement `session_attach/status/clear` in the tool layer. Ordinary calls may override `profile`, `targetId`, or `node`, but they do not rewrite attached session state unless `session_attach` is called.
- Implement `inspect` as a tool-layer composite over existing browser routes so it works identically for host, sandbox, and node proxy targets without introducing new browser-service state.
- Expose the already-existing storage, debug, and emulation browser routes through `browser-tool.schema.ts` and `browser-tool.ts` instead of leaving them hidden behind internal clients.
- Port Codex’s persistent Node kernel model into OpenClaw as `js_repl`, but keep the OpenClaw tool interface schema-based. Preserve top-level bindings, local-module reload, nested tool calls, image emission, and explicit reset.
- Route nested `openclaw.tool(...)` calls through the normal OpenClaw tool router. Block `js_repl` and `js_repl_reset` from calling themselves.
- Make `openclaw.browser.connect()` do the full interactive attach flow: ensure a session target exists, read `browser session_status`, connect over CDP with `playwright-core`, and resolve the attached page by `targetId` before returning handles.

## Patchright and Stealth

- Treat patchright as materially different from plain Playwright. Keep it.
- Standardize all OpenClaw-owned runtime code, helpers, and interactive skills on `playwright-core`; do not import plain `playwright` in `src/browser`, `src/agents`, or bundled skills.
- Do not switch the normal runtime path to plain Playwright in v1. Better flags alone do not replace patchright’s driver changes.
- Audit `src/browser/chrome.ts` against patchright’s Chromium defaults and stop forcing flags patchright deliberately removes unless a specific OpenClaw requirement justifies them. `--disable-component-update` is the first flag to remove or gate.
- Make diagnostics lazy. Do not let normal `inspect`, `navigate`, `act`, or `openclaw.browser.connect()` paths automatically depend on console/request/error instrumentation. Those hooks become explicit debug behavior.
- Prefer patchright-backed operations over raw CDP when there is an equivalent path. Keep raw `Runtime.evaluate` and similar low-level calls for explicit evaluation/debug flows only.
- Fix stale user-facing messages and docs that currently tell users to install plain `playwright` for browser AI features when this repo’s runtime is actually `playwright-core` aliased to patchright.

## Skills and Prompting

- Add a bundled OpenClaw-native `browser` skill that ports the good workflow from the global `playwright` skill, rewritten around `browser session_attach`, `browser inspect`, and `browser act`.
- Add a bundled OpenClaw-native `browser-interactive` skill that ports the good workflow from the global `playwright-interactive` skill, rewritten around `js_repl`, `openclaw.browser.connect()`, `openclaw.emitImage()`, and nested `openclaw.tool("canvas", ...)`.
- Do not add bundled skills named `playwright` or `playwright-interactive` in core v1; avoid name collision and keep OpenClaw naming consistent.
- Update `src/agents/system-prompt.ts` to advertise `js_repl`, steer ordinary browser work toward `session_attach` + `inspect`, and stop telling agents to prefer `mode=efficient` for all snapshots.

## Test Plan

- Browser tool tests:
  - attached session state is isolated per `sessionId`
  - `session_attach/status/clear` work across host, sandbox, and node routes
  - explicit per-call overrides do not mutate attached session state
  - `inspect` uses attached target by default and ignores global efficient-mode defaults unless explicitly requested
  - storage/debug/emulation actions hit existing routes correctly
- `js_repl` tests:
  - persistent bindings survive across calls
  - `js_repl_reset` clears kernel state
  - nested `openclaw.tool(...)` works for `browser` and `canvas`
  - nested self-calls to `js_repl` are rejected
  - `openclaw.emitImage(...)` emits image content items correctly
  - separate OpenClaw sessions get separate kernels
  - `await import("playwright-core")` resolves in the REPL without needing plain `playwright`
- Patchright and stealth tests:
  - no new OpenClaw runtime file imports plain `playwright`
  - managed browser launch args match the audited stealth policy
  - default inspect/session flows do not enable debug hooks
  - interactive connect path reuses the same CDP browser/profile/tab rather than launching a second browser

## Assumptions and Defaults

- The existing systemd CDP-backed OpenClaw browser service remains the source of truth. `js_repl` attaches to it; it does not launch a separate browser in the normal workflow.
- Default posture is stealth-first, because the priority is avoiding automation fingerprints on real sites.
- Broad default means `js_repl` is available anywhere the normal browser tool is available, as long as Node is present.
- No dependency swap to plain Playwright happens in v1. If version alignment between dev-only `playwright` and runtime patchright is wanted later, treat that as a separate follow-up.
