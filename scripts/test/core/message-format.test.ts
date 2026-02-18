import { describe, expect, it } from "bun:test";
import {
  isSkipResponse,
  sendChunksWithFallback,
  splitMessage,
} from "../../src/core/message-format";

describe("splitMessage", () => {
  it("returns empty array for blank input", () => {
    expect(splitMessage("")).toEqual([]);
    expect(splitMessage("  \n\t  ")).toEqual([]);
  });

  it("keeps short input as one chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("splits long input into non-empty chunks", () => {
    const text = `${"a".repeat(1999)} ${"b".repeat(1999)}`;
    const chunks = splitMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("isSkipResponse", () => {
  it("accepts [SKIP] at start", () => {
    expect(isSkipResponse("[SKIP] no send")).toBe(true);
  });

  it("accepts [SKIP] at end", () => {
    expect(isSkipResponse("no send [SKIP]")).toBe(true);
  });

  it("rejects [SKIP] in middle only", () => {
    expect(isSkipResponse("no [SKIP] send")).toBe(false);
  });
});

describe("sendChunksWithFallback", () => {
  it("sends fallback when response is empty", async () => {
    const sent: string[] = [];

    const count = await sendChunksWithFallback(
      async (chunk) => {
        sent.push(chunk);
      },
      "   ",
      {
        source: "dm",
        fallbackMessage: "fallback",
      },
    );

    expect(count).toBe(1);
    expect(sent).toEqual(["fallback"]);
  });
});
