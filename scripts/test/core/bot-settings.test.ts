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
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_METRICS_EXPORTER: "otlp",
        },
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
    expect(parsed.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(parsed.env.OTEL_METRICS_EXPORTER).toBe("otlp");
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

  it("rejects invalid env key format", () => {
    expect(() =>
      parseBotSettings(
        JSON.stringify({
          env: {
            "INVALID-KEY": "value",
          },
          schedules: [],
        }),
      ),
    ).toThrow("Invalid env key format");
  });
});
