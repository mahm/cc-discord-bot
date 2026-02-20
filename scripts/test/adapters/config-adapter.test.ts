import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyBotSettingsToConfig, loadConfig } from "../../src/adapters/config-adapter";
import { parseBotSettings } from "../../src/core/bot-settings";

const ORIGINAL_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ORIGINAL_ALLOWED_IDS = process.env.DISCORD_ALLOWED_USER_IDS;

describe("config-adapter", () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.DISCORD_ALLOWED_USER_IDS = "111,222";
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.DISCORD_BOT_TOKEN;
    } else {
      process.env.DISCORD_BOT_TOKEN = ORIGINAL_TOKEN;
    }

    if (ORIGINAL_ALLOWED_IDS === undefined) {
      delete process.env.DISCORD_ALLOWED_USER_IDS;
    } else {
      process.env.DISCORD_ALLOWED_USER_IDS = ORIGINAL_ALLOWED_IDS;
    }
  });

  it("loads prompts from scripts/src/prompts", () => {
    const config = loadConfig();

    expect(
      config.appendSystemPromptPath.endsWith("scripts/src/prompts/append-system-prompt.md"),
    ).toBe(true);
    expect(config.promptTemplatePath.endsWith("scripts/src/prompts/prompt-template.md")).toBe(true);
    expect(config.claudeTimeout).toBe(30 * 60 * 1000);
    expect(config.eventBusDbFile.endsWith("tmp/cc-discord-bot/event-bus.sqlite3")).toBe(true);
  });

  it("applies timeout seconds from bot settings", () => {
    const config = loadConfig();
    const settings = parseBotSettings(
      JSON.stringify({
        claude_timeout_seconds: 120,
        schedules: [],
      }),
    );

    applyBotSettingsToConfig(config, settings);

    expect(config.claudeTimeout).toBe(120 * 1000);
  });

  it("applies extra claude env from bot settings", () => {
    const config = loadConfig();
    const settings = parseBotSettings(
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_METRICS_EXPORTER: "otlp",
        },
        schedules: [],
      }),
    );

    applyBotSettingsToConfig(config, settings);

    expect(config.claudeEnv).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
    });
  });
});
