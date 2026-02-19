import { describe, expect, it } from "bun:test";
import {
  BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS,
  DISCORD_CONNECTION_DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DISCORD_CONNECTION_DEFAULT_RECONNECT_GRACE_SECONDS,
  DISCORD_CONNECTION_DEFAULT_STALE_THRESHOLD_SECONDS,
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
    expect(parsed.discord_connection_heartbeat_interval_seconds).toBe(
      DISCORD_CONNECTION_DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    );
    expect(parsed.discord_connection_stale_threshold_seconds).toBe(
      DISCORD_CONNECTION_DEFAULT_STALE_THRESHOLD_SECONDS,
    );
    expect(parsed.discord_connection_reconnect_grace_seconds).toBe(
      DISCORD_CONNECTION_DEFAULT_RECONNECT_GRACE_SECONDS,
    );
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

  it("rejects invalid discord connection setting ranges", () => {
    expect(() =>
      parseBotSettings(
        JSON.stringify({
          discord_connection_heartbeat_interval_seconds: 5,
          schedules: [],
        }),
      ),
    ).toThrow("discord_connection_heartbeat_interval_seconds");

    expect(() =>
      parseBotSettings(
        JSON.stringify({
          discord_connection_stale_threshold_seconds: 20,
          schedules: [],
        }),
      ),
    ).toThrow("discord_connection_stale_threshold_seconds");

    expect(() =>
      parseBotSettings(
        JSON.stringify({
          discord_connection_reconnect_grace_seconds: 200,
          schedules: [],
        }),
      ),
    ).toThrow("discord_connection_reconnect_grace_seconds");
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
