import { describe, expect, it } from "vitest";
import { extractDeclaredStopReasonFromText, stripDeclaredStopReasonLine } from "./stop-reason.js";

describe("stop reason parsing", () => {
  it("parses completed reason when marker is the final line", () => {
    expect(extractDeclaredStopReasonFromText("Done.\nOPENCLAW_STOP_REASON: completed")).toBe(
      "completed",
    );
  });

  it("parses needs_user_input reason when marker is the final line", () => {
    expect(
      extractDeclaredStopReasonFromText("Need branch.\nOPENCLAW_STOP_REASON: needs_user_input"),
    ).toBe("needs_user_input");
  });

  it("rejects empty and invalid trailing reasons", () => {
    expect(extractDeclaredStopReasonFromText("OPENCLAW_STOP_REASON:")).toBeUndefined();
    expect(extractDeclaredStopReasonFromText("OPENCLAW_STOP_REASON: maybe")).toBeUndefined();
  });

  it("ignores non-trailing marker lines for stop reason parsing", () => {
    expect(extractDeclaredStopReasonFromText("OPENCLAW_STOP_REASON: completed\n\nAll done.")).toBe(
      undefined,
    );
  });

  it("strips trailing reason line from user-facing text", () => {
    expect(stripDeclaredStopReasonLine("All done.\n\nOPENCLAW_STOP_REASON: completed")).toBe(
      "All done.",
    );
  });

  it("strips trailing empty and invalid reason lines from user-facing text", () => {
    expect(stripDeclaredStopReasonLine("All done.\n\nOPENCLAW_STOP_REASON:")).toBe("All done.");
    expect(stripDeclaredStopReasonLine("All done.\n\nOPENCLAW_STOP_REASON: maybe")).toBe(
      "All done.",
    );
  });

  it("does not strip non-trailing marker lines", () => {
    expect(stripDeclaredStopReasonLine("OPENCLAW_STOP_REASON: completed\n\nAll done.")).toBe(
      "OPENCLAW_STOP_REASON: completed\n\nAll done.",
    );
  });
});
