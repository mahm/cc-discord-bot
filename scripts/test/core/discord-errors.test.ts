import { describe, expect, it } from "bun:test";
import {
  classifyDiscordError,
  isTerminalDiscordError,
  parseDiscordCode,
  parseDiscordStatus,
} from "../../src/core/discord-errors";

describe("discord-errors", () => {
  it("detects known terminal Discord API codes", () => {
    const unknownMessage = { code: 10_008 };
    expect(parseDiscordCode(unknownMessage)).toBe(10_008);
    expect(isTerminalDiscordError(unknownMessage)).toBe(true);
    expect(classifyDiscordError(unknownMessage)).toBe("terminal");
  });

  it("treats non-terminal Discord API codes as retryable", () => {
    const serverError = { code: 50_035 };
    expect(isTerminalDiscordError(serverError)).toBe(false);
    expect(classifyDiscordError(serverError)).toBe("retryable");
  });

  it("parses status when available and defaults to retryable", () => {
    const rateLimited = { status: 429 };
    expect(parseDiscordCode(rateLimited)).toBeNull();
    expect(parseDiscordStatus(rateLimited)).toBe(429);
    expect(classifyDiscordError(rateLimited)).toBe("retryable");
  });

  it("handles non-object errors safely", () => {
    expect(parseDiscordCode("boom")).toBeNull();
    expect(parseDiscordStatus("boom")).toBeNull();
    expect(isTerminalDiscordError("boom")).toBe(false);
    expect(classifyDiscordError("boom")).toBe("retryable");
  });
});
