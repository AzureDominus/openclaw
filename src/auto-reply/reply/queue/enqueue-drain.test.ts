import { afterEach, describe, expect, it } from "vitest";
import type { FollowupRun, QueueSettings } from "./types.js";
import { scheduleFollowupDrain } from "./drain.js";
import { enqueueFollowupRun } from "./enqueue.js";
import { FOLLOWUP_QUEUES } from "./state.js";

function createRun(sessionId: string): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId,
    sessionKey: "main",
    messageProvider: "whatsapp",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: {},
    provider: "openai",
    model: "gpt-4.1",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
  };
}

function createSettings(mode: QueueSettings["mode"]): QueueSettings {
  return {
    mode,
    debounceMs: 0,
    cap: 20,
    dropPolicy: "summarize",
  };
}

function createFollowup(params: {
  prompt: string;
  messageId?: string;
  sessionId: string;
  to?: string;
}): FollowupRun {
  return {
    prompt: params.prompt,
    messageId: params.messageId,
    summaryLine: params.prompt,
    enqueuedAt: Date.now(),
    originatingChannel: "whatsapp",
    originatingTo: params.to ?? "+15550001111",
    run: createRun(params.sessionId),
  };
}

describe("followup queue", () => {
  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
  });

  it("upserts queued item when the same provider message id is edited", () => {
    const key = "session-a";
    const settings = createSettings("queue");

    const first = enqueueFollowupRun(
      key,
      createFollowup({
        prompt: "old text",
        messageId: "msg-1",
        sessionId: "session-a",
      }),
      settings,
    );
    const second = enqueueFollowupRun(
      key,
      createFollowup({
        prompt: "edited text",
        messageId: "msg-1",
        sessionId: "session-a",
      }),
      settings,
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    const queue = FOLLOWUP_QUEUES.get(key);
    expect(queue?.items).toHaveLength(1);
    expect(queue?.items[0]?.prompt).toBe("edited text");
  });

  it("drains queued items in one batched followup payload per route", async () => {
    const key = "session-b";
    const settings = createSettings("queue");
    enqueueFollowupRun(
      key,
      createFollowup({ prompt: "first message", messageId: "m-1", sessionId: "session-b" }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createFollowup({ prompt: "second message", messageId: "m-2", sessionId: "session-b" }),
      settings,
    );

    const delivered: FollowupRun[] = [];
    scheduleFollowupDrain(key, async (run) => {
      delivered.push(run);
    });

    await expect
      .poll(() => delivered.length, {
        timeout: 2_000,
      })
      .toBe(1);
    expect(delivered[0]?.prompt).toContain("first message");
    expect(delivered[0]?.prompt).toContain("second message");
  });
});
