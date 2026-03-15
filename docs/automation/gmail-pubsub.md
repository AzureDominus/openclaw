---
summary: "Legacy Gmail Pub/Sub watcher flow removed from OpenClaw"
read_when:
  - Migrating from the old Gmail Pub/Sub watcher flow
  - Wiring an external Gmail ingestor into OpenClaw
title: "Gmail PubSub"
---

# Gmail Pub/Sub

OpenClaw no longer manages Gmail Pub/Sub watches or the old local watch daemon.
That flow depended on a legacy watcher CLI and was removed without a `gws`
replacement.

## What still works

- OpenClaw still accepts `POST /hooks/gmail` from an external ingestor.
- `hooks.presets: ["gmail"]`, `hooks.mappings`, `hooks.gmail.model`,
  `hooks.gmail.thinking`, and `hooks.gmail.allowUnsafeExternalContent` still
  apply to Gmail webhook payloads.
- Use `gws` for direct Gmail CLI tasks such as searching, reading, or sending mail.

## What was removed

- `openclaw webhooks gmail setup`
- `openclaw webhooks gmail run`
- Gateway-managed Gmail watch renewal and local Pub/Sub callback serving

## Recommended path

1. Enable OpenClaw hooks and the Gmail preset or a custom mapping.
2. Run your own Gmail watcher or Pub/Sub bridge outside OpenClaw.
3. Deliver the normalized payload to `POST /hooks/gmail`.

Example config:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    gmail: {
      model: "openai/gpt-5.2-mini",
      thinking: "off",
    },
  },
}
```

For hook auth, routing, mappings, and payload examples, see [Webhooks](/automation/webhook).
