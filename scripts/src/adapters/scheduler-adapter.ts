import { readFile } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import type { Client, User } from "discord.js";
import { type BotSettings, parseBotSettings } from "../core/bot-settings";
import { isSkipResponse, splitMessage } from "../core/message-format";
import { sendToClaude } from "./claude-adapter";
import type { Config } from "./config-adapter";

type Schedule = BotSettings["schedules"][number];

export async function loadBotSettings(config: Config): Promise<BotSettings> {
  const settingsPath = path.join(config.projectRoot, ".claude", "settings.bot.json");
  const content = await readFile(settingsPath, "utf-8");
  return parseBotSettings(content);
}

function expandPrompt(template: string): string {
  const now = new Date();
  const datetimeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return template.replace(/\{\{datetime\}\}/g, datetimeStr);
}

async function buildPrompt(schedule: Schedule, config: Config): Promise<string> {
  let prompt = schedule.prompt;
  if (schedule.prompt_file) {
    const filePath = path.join(config.projectRoot, schedule.prompt_file);
    const fileContent = await readFile(filePath, "utf-8");
    prompt = `${fileContent}\n\n---\n\n${prompt}`;
  }
  return expandPrompt(prompt);
}

async function sendDiscordDM(
  client: Client,
  userId: string,
  text: string,
  context: string,
): Promise<number> {
  const chunks = splitMessage(text).filter((chunk) => chunk.trim().length > 0);
  if (chunks.length === 0) {
    console.log(`[scheduler] Discord notification suppressed (reason=empty-response, ${context})`);
    return 0;
  }

  const user: User = await client.users.fetch(userId);
  for (const chunk of chunks) {
    await user.send(chunk);
  }
  return chunks.length;
}

async function runSchedule(
  schedule: Schedule,
  settings: BotSettings,
  config: Config,
  client?: Client,
): Promise<string> {
  console.log(`[scheduler] Running schedule: ${schedule.name}`);
  const startTime = Date.now();

  try {
    const prompt = await buildPrompt(schedule, config);
    const result = await sendToClaude(prompt, config, {
      bypassMode: settings["bypass-mode"],
      source: "scheduler",
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[scheduler] Schedule "${schedule.name}" completed in ${elapsed}s (${result.response.length} chars, session: ${result.sessionId})`,
    );

    if (schedule.skippable && isSkipResponse(result.response)) {
      console.log(
        `[scheduler] Schedule "${schedule.name}" skipped (reason=skip-token-at-start-or-end)`,
      );
      return result.response;
    }

    if (schedule.discord_notify && client) {
      const targetUserId = config.allowedUserIds[0];
      const sentChunks = await sendDiscordDM(
        client,
        targetUserId,
        result.response,
        `schedule=${schedule.name},user=${targetUserId}`,
      );
      if (sentChunks > 0) {
        console.log(
          `[scheduler] DM sent to ${targetUserId} for "${schedule.name}" (chunks=${sentChunks})`,
        );
      }
    }

    return result.response;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[scheduler] Schedule "${schedule.name}" failed: ${errorMsg}`);

    throw error;
  }
}

export function startScheduler(settings: BotSettings, config: Config, client: Client): void {
  if (settings.schedules.length === 0) {
    console.log("[scheduler] No schedules configured");
    return;
  }

  for (const schedule of settings.schedules) {
    const job = new Cron(schedule.cron, { timezone: schedule.timezone }, () => {
      runSchedule(schedule, settings, config, client).catch(() => {
        // Error already logged in runSchedule
      });
    });

    const nextRun = job.nextRun();
    console.log(
      `[scheduler] Registered "${schedule.name}" (${schedule.cron}) ` +
        `timezone=${schedule.timezone}, next=${nextRun?.toISOString() ?? "unknown"}`,
    );
  }

  console.log(`[scheduler] Started with ${settings.schedules.length} schedule(s)`);
}

export async function runScheduleByName(
  name: string,
  settings: BotSettings,
  config: Config,
): Promise<string> {
  const schedule = settings.schedules.find((s) => s.name === name);
  if (!schedule) {
    const available = settings.schedules.map((s) => s.name).join(", ");
    throw new Error(`Schedule "${name}" not found. Available: ${available || "(none)"}`);
  }

  return runSchedule(schedule, settings, config);
}
