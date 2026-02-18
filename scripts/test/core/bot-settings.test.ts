import { describe, expect, it } from "bun:test";
import {
  BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS,
  parseBotSettings,
} from "../../src/core/bot-settings";

describe("parseBotSettings", () => {
  it("parses valid config and applies timeout default", () => {
    const parsed = parseBotSettings(
      JSON.stringify({
        "bypass-mode": true,
        schedules: [
          {
            name: "heartbeat",
            cron: "*/10 * * * *",
            timezone: "Asia/Tokyo",
            prompt: "hello",
            discord_notify: true,
            skippable: true,
          },
        ],
      }),
    );

    expect(parsed["bypass-mode"]).toBe(true);
    expect(parsed.claude_timeout_seconds).toBe(BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS);
    expect(parsed.schedules.length).toBe(1);
  });

  it("rejects invalid timeout range", () => {
    expect(() =>
      parseBotSettings(
        JSON.stringify({
          claude_timeout_seconds: 5,
          schedules: [],
        }),
      ),
    ).toThrow("claude_timeout_seconds");
  });

  it("rejects unknown keys", () => {
    expect(() =>
      parseBotSettings(
        JSON.stringify({
          schedules: [],
          unknown: true,
        }),
      ),
    ).toThrow("Unrecognized key");
  });
});
