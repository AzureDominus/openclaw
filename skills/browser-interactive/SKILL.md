---
name: browser-interactive
description: Persistent browser interaction through js_repl and OpenClaw helpers. Use for iterative UI debugging on the attached CDP browser session.
---

# Browser Interactive

Use this skill when the task needs a persistent interactive browser session.

This repo uses `playwright-core`, which resolves to `patchright` here. In `js_repl`, import `playwright-core`, not `playwright`, unless you are explicitly working on separate dev-only test code.

## Preconditions

- `js_repl` must be available.
- OpenClaw's browser service must already be running.
- The normal browser path should attach first:
  - `browser` action=`session_attach`
  - then `browser` action=`inspect`

## Core Workflow

1. Attach the browser session with `browser`.
2. Run a bootstrap cell in `js_repl`.
3. Reuse the same `browser`, `page`, and helper bindings across later cells.
4. Emit screenshots with `openclaw.emitImage(...)` when visual evidence matters.
5. Use `js_repl_reset` only when the session state is stale or you need a clean restart.

## Bootstrap Cell

```javascript
var playwright;
var cdp;
var browserConnection;
var page;

cdp = await openclaw.browser.sessionStatus();
({ playwright, browser: browserConnection, page } = await openclaw.browser.connect());

({
  profile: cdp.profile,
  targetId: cdp.targetId,
  url: page.url(),
});
```

## Reuse Rules

- Use `var` for long-lived handles you want to keep between cells.
- Reuse `page` unless the browser target changed.
- If the attached tab changed, rerun the bootstrap cell.
- If the REPL state is corrupted or stale, call `js_repl_reset` and bootstrap again.

## Common Patterns

- Inspect page state:

```javascript
await page.title();
```

- Interact with the live page:

```javascript
await page.getByRole("button", { name: "Save" }).click();
await page.waitForLoadState("domcontentloaded");
```

- Emit a screenshot:

```javascript
await openclaw.emitImage({
  bytes: await page.screenshot({ type: "jpeg", quality: 85 }),
  mimeType: "image/jpeg",
});
```

- Call another OpenClaw tool from JS:

```javascript
await openclaw.tool("browser", { action: "console" });
await openclaw.tool("canvas", { action: "snapshot", node: "node-id" });
```

## Guardrails

- Do not import plain `playwright` for the default interactive workflow in this repo.
- Do not launch a second local browser unless the task explicitly requires it.
- Prefer `openclaw.browser.connect()` over hand-assembling `connectOverCDP(...)`.
- Keep normal browser observation on the `browser` tool side when possible; use REPL code for persistent handles and custom logic.
