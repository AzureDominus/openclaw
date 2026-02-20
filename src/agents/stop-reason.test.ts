import { describe, expect, it } from "vitest";
import { extractDeclaredStopReasonFromText, stripDeclaredStopReasonLine } from "./stop-reason.js";

describe("stop reason parsing", () => {
  it("parses completed reason", () => {
    expect(extractDeclaredStopReasonFromText("OPENCLAW_STOP_REASON: completed\nDone.")).toBe(
      "completed",
    );
  });

  it("parses needs_user_input reason", () => {
    expect(
      extractDeclaredStopReasonFromText("OPENCLAW_STOP_REASON: needs_user_input\nNeed branch."),
    ).toBe("needs_user_input");
  });

  it("rejects empty and invalid reasons", () => {
    expect(extractDeclaredStopReasonFromText("OPENCLAW_STOP_REASON:")).toBeUndefined();
    expect(extractDeclaredStopReasonFromText("OPENCLAW_STOP_REASON: maybe")).toBeUndefined();
  });

  it("strips reason line from user-facing text", () => {
    expect(stripDeclaredStopReasonLine("OPENCLAW_STOP_REASON: completed\n\nAll done.")).toBe(
      "All done.",
    );
  });
});
