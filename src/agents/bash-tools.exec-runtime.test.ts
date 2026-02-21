import { describe, expect, it } from "vitest";
import { isExecOutputCapTruncated } from "./bash-tools.exec-runtime.js";

describe("exec runtime truncation helpers", () => {
  it("returns true only when output exceeds the configured cap", () => {
    expect(isExecOutputCapTruncated({ totalOutputChars: 41_000, outputCapChars: 40_000 })).toBe(
      true,
    );
    expect(isExecOutputCapTruncated({ totalOutputChars: 40_000, outputCapChars: 40_000 })).toBe(
      false,
    );
    expect(isExecOutputCapTruncated({ totalOutputChars: 11_497, outputCapChars: 40_000 })).toBe(
      false,
    );
  });
});
