---
summary: "CLI reference for `openclaw webhooks`"
read_when:
  - You want webhook helper commands
title: "webhooks"
---

# `openclaw webhooks`

Webhook helpers and integrations.

Related:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup
openclaw webhooks gmail run
```

These legacy Gmail Pub/Sub watcher commands now exit with a removal message.
OpenClaw still accepts `POST /hooks/gmail` from an external ingestor.

See [Webhook](/automation/webhook) for the supported hook path, and
[Gmail Pub/Sub](/automation/gmail-pubsub) for migration notes.
