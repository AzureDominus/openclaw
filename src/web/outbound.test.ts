import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { setActiveWebListener } from "./active-listener.js";

const loadWebMediaMock = vi.fn();
const TINY_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+8f8AAAAASUVORK5CYII=",
  "base64",
);
vi.mock("./media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
}));
const loadConfigMock = vi.fn(() => ({}));
vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

import { sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp } from "./outbound.js";

describe("web outbound", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => ({ messageId: "msg123" }));
  const sendPoll = vi.fn(async () => ({ messageId: "poll123" }));
  const sendReaction = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({});
    setActiveWebListener({
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    setActiveWebListener(null);
  });

  it("sends message via active listener", async () => {
    const result = await sendMessageWhatsApp("+1555", "hi", { verbose: false });
    expect(result).toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).toHaveBeenCalledWith("+1555");
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("throws a helpful error when no active listener exists", async () => {
    setActiveWebListener(null);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, accountId: "work" }),
    ).rejects.toThrow(/No active WhatsApp Web listener/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, accountId: "work" }),
    ).rejects.toThrow(/channels login/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, accountId: "work" }),
    ).rejects.toThrow(/account: work/);
  });

  it("maps audio to PTT with opus mime when ogg", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
    });
    await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      mediaUrl: "/tmp/voice.ogg",
    });
    expect(sendMessage).toHaveBeenLastCalledWith(
      "+1555",
      "voice note",
      buf,
      "audio/ogg; codecs=opus",
    );
  });

  it("maps video with caption", async () => {
    const buf = Buffer.from("video");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWhatsApp("+1555", "clip", {
      verbose: false,
      mediaUrl: "/tmp/video.mp4",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "clip", buf, "video/mp4");
  });

  it("marks gif playback for video when requested", async () => {
    const buf = Buffer.from("gifvid");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWhatsApp("+1555", "gif", {
      verbose: false,
      mediaUrl: "/tmp/anim.mp4",
      gifPlayback: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });
  });

  it("maps image with caption", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      mediaUrl: "/tmp/pic.jpg",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", buf, "image/jpeg");
  });

  it("uses configured mediaMaxMb when loading outbound media", async () => {
    const buf = Buffer.from("img");
    loadConfigMock.mockReturnValue({
      channels: { whatsapp: { mediaMaxMb: 12 } },
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      mediaUrl: "/tmp/pic.jpg",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("/tmp/pic.jpg", {
      maxBytes: 12 * 1024 * 1024,
      localRoots: undefined,
    });
  });

  it("sends oversized browser screenshots as documents in auto mode", async () => {
    const buf = Buffer.alloc(20 * 1024 * 1024 + 1);
    loadConfigMock.mockReturnValue({
      channels: { whatsapp: { imageUploadMode: "auto" } },
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
      fileName: "shot.jpg",
    });

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      mediaUrl: "/home/user/.openclaw/media/browser/shot.jpg",
    });

    expect(sendMessage).toHaveBeenLastCalledWith(
      "+1555",
      "pic",
      expect.any(Buffer),
      "image/jpeg",
      expect.objectContaining({
        sendImageAsDocument: true,
        fileName: "shot.jpg",
      }),
    );
  });

  it("keeps small browser screenshots as images in auto mode", async () => {
    const buf = TINY_PNG_BUFFER;
    loadConfigMock.mockReturnValue({
      channels: { whatsapp: { imageUploadMode: "auto" } },
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
      fileName: "shot.jpg",
    });

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      mediaUrl: "/home/user/.openclaw/media/browser/shot.jpg",
    });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", buf, "image/jpeg");
  });

  it("keeps tall browser screenshots as images in auto mode when size is within limit", async () => {
    const buf = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1265" height="4831"></svg>',
    );
    loadConfigMock.mockReturnValue({
      channels: { whatsapp: { imageUploadMode: "auto" } },
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/png",
      kind: "image",
      fileName: "long.png",
    });

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      mediaUrl: "/home/user/.openclaw/media/browser/long.png",
    });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", buf, "image/png");
  });

  it("honors configured WhatsApp auto maxBytes gate", async () => {
    const buf = Buffer.alloc(2 * 1024);
    loadConfigMock.mockReturnValue({
      channels: {
        whatsapp: {
          imageUploadMode: "auto",
          imageAutoDocument: { maxBytes: 1 },
        },
      },
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
      fileName: "shot.jpg",
    });

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      mediaUrl: "/home/user/.openclaw/media/browser/shot.jpg",
    });

    expect(sendMessage).toHaveBeenLastCalledWith(
      "+1555",
      "pic",
      expect.any(Buffer),
      "image/jpeg",
      expect.objectContaining({
        sendImageAsDocument: true,
        fileName: "shot.jpg",
      }),
    );
  });

  it("treats zero WhatsApp auto gates as disabled", async () => {
    const buf = Buffer.alloc(2 * 1024);
    loadConfigMock.mockReturnValue({
      channels: {
        whatsapp: {
          imageUploadMode: "auto",
          imageAutoDocument: { maxBytes: 0, browserMaxSide: 0, browserMaxPixels: 0 },
        },
      },
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
      fileName: "shot.jpg",
    });

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      mediaUrl: "/home/user/.openclaw/media/browser/shot.jpg",
    });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", expect.any(Buffer), "image/jpeg");
  });

  it("maps other kinds to document with filename", async () => {
    const buf = Buffer.from("pdf");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "application/pdf",
      kind: "document",
      fileName: "file.pdf",
    });
    await sendMessageWhatsApp("+1555", "doc", {
      verbose: false,
      mediaUrl: "/tmp/file.pdf",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "application/pdf", {
      fileName: "file.pdf",
    });
  });

  it("sends polls via active listener", async () => {
    const result = await sendPollWhatsApp(
      "+1555",
      { question: "Lunch?", options: ["Pizza", "Sushi"], maxSelections: 2 },
      { verbose: false },
    );
    expect(result).toEqual({
      messageId: "poll123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendPoll).toHaveBeenCalledWith("+1555", {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 2,
      durationSeconds: undefined,
      durationHours: undefined,
    });
  });

  it("redacts recipients and poll text in outbound logs", async () => {
    const logPath = path.join(os.tmpdir(), `openclaw-outbound-${crypto.randomUUID()}.log`);
    setLoggerOverride({ level: "trace", file: logPath });

    await sendPollWhatsApp(
      "+1555",
      { question: "Lunch?", options: ["Pizza", "Sushi"], maxSelections: 1 },
      { verbose: false },
    );

    await vi.waitFor(
      () => {
        expect(fsSync.existsSync(logPath)).toBe(true);
      },
      { timeout: 2_000, interval: 5 },
    );

    const content = fsSync.readFileSync(logPath, "utf-8");
    expect(content).toContain(redactIdentifier("+1555"));
    expect(content).toContain(redactIdentifier("1555@s.whatsapp.net"));
    expect(content).not.toContain(`"to":"+1555"`);
    expect(content).not.toContain(`"jid":"1555@s.whatsapp.net"`);
    expect(content).not.toContain("Lunch?");
  });

  it("sends reactions via active listener", async () => {
    await sendReactionWhatsApp("1555@s.whatsapp.net", "msg123", "✅", {
      verbose: false,
      fromMe: false,
    });
    expect(sendReaction).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      "msg123",
      "✅",
      false,
      undefined,
    );
  });
});
