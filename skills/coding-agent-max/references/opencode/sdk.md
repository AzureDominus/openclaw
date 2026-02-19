# OpenCode SDK Reference

Type-safe JavaScript/TypeScript SDK for programmatic OpenCode control.

**When to use:** Only read this if you need to write code that controls OpenCode programmatically. For CLI-based automation, use `references/opencode/cli.md` instead.

---

## Install

```bash
npm install @opencode-ai/sdk
```

---

## Quick Start

### Create Client + Server

```typescript
import { createOpencode } from "@opencode-ai/sdk";

const { client, server } = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  config: {
    model: "anthropic/claude-opus-4-5",
  },
});

// Use client...
// When done:
server.close();
```

### Connect to Existing Server

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
});
```

---

## Key APIs

### Sessions

```typescript
// Create session
const session = await client.session.create({
  body: { title: "My task" },
});

// Send prompt and wait for response
const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
    parts: [{ type: "text", text: "Add error handling to src/api.ts" }],
  },
});

// Send prompt without waiting (async)
await client.session.promptAsync({
  path: { id: session.id },
  body: {
    parts: [{ type: "text", text: "Background task..." }],
  },
});

// Abort running session
await client.session.abort({ path: { id: session.id } });

// Fork session at specific message
const forked = await client.session.fork({
  path: { id: session.id },
  body: { messageID: "msg-123" },
});

// List sessions
const sessions = await client.session.list();
```

### Events (SSE Stream)

```typescript
const events = await client.event.subscribe();
for await (const event of events.stream) {
  console.log("Event:", event.type, event.properties);
}
```

### Files

```typescript
// Search for text
const matches = await client.find.text({
  query: { pattern: "function.*handleAuth" },
});

// Find files
const files = await client.find.files({
  query: { query: "*.ts", type: "file", limit: 50 },
});

// Read file
const content = await client.file.read({
  query: { path: "src/index.ts" },
});
```

---

## Server HTTP API

When using `opencode serve`, these endpoints are available:

| Method | Endpoint                    | Description          |
| ------ | --------------------------- | -------------------- |
| `GET`  | `/global/health`            | Health check         |
| `GET`  | `/session`                  | List sessions        |
| `POST` | `/session`                  | Create session       |
| `POST` | `/session/:id/message`      | Send message (sync)  |
| `POST` | `/session/:id/prompt_async` | Send message (async) |
| `POST` | `/session/:id/abort`        | Abort session        |
| `GET`  | `/session/:id/diff`         | Get file diffs       |
| `GET`  | `/agent`                    | List agents          |
| `GET`  | `/doc`                      | OpenAPI spec         |

Full spec at `http://localhost:4096/doc`

---

## Types

```typescript
import type { Session, Message, Part } from "@opencode-ai/sdk";
```

All types generated from OpenAPI spec.
