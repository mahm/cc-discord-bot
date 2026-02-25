import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS,
  BOT_SETTINGS_RELATIVE_PATH,
  loadBotSettings,
} from "../../src/core/runtime-settings";

describe("loadBotSettings", () => {
  it("loads settings from .claude/settings.bot.json under project root", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "cc-discord-bot-runtime-settings-"));

    try {
      const settingsPath = path.join(projectRoot, BOT_SETTINGS_RELATIVE_PATH);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          "bypass-mode": true,
          schedules: [
            {
              name: "heartbeat",
              cron: "*/10 * * * *",
              timezone: "Asia/Tokyo",
              prompt: "hello",
              discord_notify: true,
            },
          ],
        }),
        "utf-8",
      );

      const parsed = await loadBotSettings(projectRoot);
      expect(parsed["bypass-mode"]).toBe(true);
      expect(parsed.claude_timeout_seconds).toBe(BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS);
      expect(parsed.schedules[0]?.name).toBe("heartbeat");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
