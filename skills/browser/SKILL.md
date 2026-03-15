---
name: browser
description: Use OpenClaw's browser tool for normal browser automation and page inspection. Prefer session_attach plus inspect before acting.
---

# Browser

Use this skill when the task requires controlling a real browser through OpenClaw's `browser` tool.

## Default Workflow

1. Attach once with `browser` action=`session_attach`.
2. Inspect the current page with action=`inspect`.
3. Act using the same attached tab.
4. Re-inspect after navigation or major UI changes.

## Core Pattern

- Attach the session:

```json
{ "action": "session_attach" }
```

- Inspect for combined snapshot and screenshot context:

```json
{ "action": "inspect" }
```

- Act on the same attached page:

```json
{
  "action": "act",
  "request": { "kind": "click", "ref": "e12" }
}
```

## Session Rules

- If the user mentions the Chrome extension, Browser Relay, or attaching an existing Chrome tab, use `profile="chrome"`.
- For Chrome Relay, the user must click the OpenClaw Browser Relay toolbar icon on the target tab first.
- After `session_attach`, later `browser` calls can usually omit `targetId`.
- Use `session_status` when you need the current attached tab metadata.
- Use `session_clear` if the session target is stale and you need to reattach cleanly.

## Inspection Guidance

- Prefer `inspect` over raw `snapshot` when you need broad context quickly.
- Use `snapshot` when you explicitly want a text-only or compact result.
- Use `mode="efficient"` only when you want a smaller snapshot on purpose.
- Prefer `refs="aria"` when you need stable element references across repeated calls.

## Common Actions

- Open a new tab:

```json
{ "action": "open", "url": "https://example.com" }
```

- Navigate the attached tab:

```json
{ "action": "navigate", "url": "https://example.com/settings" }
```

- Read console messages:

```json
{ "action": "console" }
```

- Capture a screenshot:

```json
{ "action": "screenshot", "fullPage": true, "type": "jpeg" }
```

## Debug Actions

- `errors`
- `requests`
- `trace_start`
- `trace_stop`
- `cookies_get`, `cookies_set`, `cookies_clear`
- `storage_get`, `storage_set`, `storage_clear`

## When To Escalate To browser-interactive

Switch to the `browser-interactive` skill when you need:

- Persistent page or browser handles across many iterations
- Direct Patchright-backed Playwright access through CDP
- Custom JavaScript inspection or ad hoc automation loops
- Repeated screenshots emitted from the same live page
