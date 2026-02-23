import { readFile } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { SCHEDULER_EVENT_TTL_MS, type SchedulerTriggeredEventPayload } from "../core/bot-events";
import { type BotSettings, parseBotSettings } from "../core/bot-settings";
import { isSkipResponse, stripThinkTags } from "../core/message-format";
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
  const parts: string[] = [];

  // 教訓ファイルを埋め込み(存在すれば)
  const lessonsPath = path.join(config.projectRoot, "AGENT_LESSONS.md");
  try {
    const lessons = await readFile(lessonsPath, "utf-8");
    parts.push(lessons);
  } catch {
    // ファイルがなければスキップ
  }

  if (schedule.prompt_file) {
    const filePath = path.join(config.projectRoot, schedule.prompt_file);
    const fileContent = await readFile(filePath, "utf-8");
    parts.push(fileContent);
  }

  parts.push(schedule.prompt);
  return expandPrompt(parts.join("\n\n---\n\n"));
}

async function runSchedule(
  schedule: Schedule,
  settings: BotSettings,
  config: Config,
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

    const cleaned = stripThinkTags(result.response);

    if (schedule.skippable && isSkipResponse(cleaned)) {
      console.log(
        `[scheduler] Schedule "${schedule.name}" skipped (reason=skip-token-at-start-or-end)`,
      );
      return cleaned;
    }

    return cleaned;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[scheduler] Schedule "${schedule.name}" failed: ${errorMsg}`);

    throw error;
  }
}

export function startSchedulerWithPublisher(
  settings: BotSettings,
  publishTriggered: (payload: SchedulerTriggeredEventPayload) => void,
): void {
  if (settings.schedules.length === 0) {
    console.log("[scheduler] No schedules configured");
    return;
  }

  for (const schedule of settings.schedules) {
    const job = new Cron(schedule.cron, { timezone: schedule.timezone }, () => {
      const triggeredAt = Date.now();
      publishTriggered({
        scheduleName: schedule.name,
        triggeredAt,
        expiresAt: triggeredAt + SCHEDULER_EVENT_TTL_MS,
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
