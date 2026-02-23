import { describe, expect, it } from "bun:test";
import {
  isSkipResponse,
  sendChunksWithFallback,
  splitMessage,
  stripThinkTags,
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

describe("stripThinkTags", () => {
  it("removes a single <think> block", () => {
    const input = "<think>internal reasoning here</think>Hello!";
    expect(stripThinkTags(input)).toBe("Hello!");
  });

  it("removes multiple <think> blocks", () => {
    const input = "<think>first</think>Hello <think>second</think>world";
    expect(stripThinkTags(input)).toBe("Hello world");
  });

  it("returns text unchanged when no <think> tags present", () => {
    const input = "Just a normal message";
    expect(stripThinkTags(input)).toBe("Just a normal message");
  });

  it("preserves text before and after <think> block", () => {
    const input = "Before <think>hidden</think> After";
    expect(stripThinkTags(input)).toBe("Before  After");
  });

  it("handles multiline content inside <think> tags", () => {
    const input = `<think>
18:50 now. Last DM was at 18:28.
SD誌 is today's deadline...
A gentle check-in seems appropriate.
</think>
SD誌のスクショ撮り直し、進んでますかー?`;
    expect(stripThinkTags(input)).toBe("SD誌のスクショ撮り直し、進んでますかー?");
  });

  it("handles <think> block with only [SKIP]", () => {
    const input = "<think>No need to send</think>[SKIP]";
    expect(stripThinkTags(input)).toBe("[SKIP]");
  });

  it("returns empty string when only <think> block exists", () => {
    const input = "<think>only thinking</think>";
    expect(stripThinkTags(input)).toBe("");
  });
});

describe("sendChunksWithFallback", () => {
  it("does not send any message when fallback is omitted", async () => {
    const sent: string[] = [];

    const count = await sendChunksWithFallback(
      async (chunk) => {
        sent.push(chunk);
      },
      "   ",
      {
        source: "scheduler",
      },
    );

    expect(count).toBe(0);
    expect(sent).toEqual([]);
  });

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
