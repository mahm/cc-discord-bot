import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { SCHEDULER_EVENT_TTL_MS, type SchedulerTriggeredEventPayload } from "../core/bot-events";
import { type BotSettings, parseBotSettings } from "../core/bot-settings";
import { formatConversationAsMarkdown, type SqliteEventBus } from "../core/event-bus";
import { isSkipResponse, stripThinkTags } from "../core/message-format";
import { type SessionTarget, sendToClaude } from "./claude-adapter";
import type { Config } from "./config-adapter";

type Schedule = BotSettings["schedules"][number];

export async function loadBotSettings(config: Config): Promise<BotSettings> {
  const settingsPath = path.join(config.projectRoot, ".claude", "settings.bot.json");
  const content = await readFile(settingsPath, "utf-8");
  return parseBotSettings(content);
}

async function readTodayHandoffs(handoffsDir: string): Promise<string[]> {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const todayDir = path.join(handoffsDir, String(y), m, d);

  let entries: string[];
  try {
    entries = await readdir(todayDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
  const results: string[] = [];
  for (const file of mdFiles) {
    try {
      const content = await readFile(path.join(todayDir, file), "utf-8");
      results.push(content);
    } catch {
      // ファイル読み込みエラーはスキップ
    }
  }
  return results;
}

function expandPrompt(template: string): string {
  const now = new Date();
  const datetimeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return template.replace(/\{\{datetime\}\}/g, datetimeStr);
}

async function buildPrompt(
  schedule: Schedule,
  config: Config,
  eventBus?: SqliteEventBus,
): Promise<string> {
  const parts: string[] = [];

  // 教訓ファイルを埋め込み(存在すれば)
  const lessonsPath = path.join(config.projectRoot, "AGENT_LESSONS.md");
  try {
    const lessons = await readFile(lessonsPath, "utf-8");
    parts.push(lessons);
  } catch {
    // ファイルがなければスキップ
  }

  // 隔離セッション向け: DM対話ログ注入
  if (schedule.session_mode === "isolated" && eventBus) {
    const messages = eventBus.getRecentDmConversation(20);
    if (messages.length > 0) {
      parts.push(
        `## 最近のDiscord DM会話(参考コンテキスト)\n\n${formatConversationAsMarkdown(messages)}`,
      );
    }
  }

  // 隔離セッション向け: 申し送り事項の書き込み指示
  if (schedule.session_mode === "isolated") {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const handoffPath = `tmp/cc-discord-bot/handoffs/${y}/${m}/${d}/${schedule.name}.md`;
    parts.push(
      [
        "## 申し送り事項の書き方",
        "",
        `タスク完了後、今日の作業内容を以下のファイルに書き込んでください(上書き):`,
        `  ${handoffPath}`,
        "",
        "今日日付で実際にやったことを正確に記録してください。全体で5000文字以内に収めてください。",
        "具体的にどのファイルに何を書いたか、何を変更したかが分かるように書いてください。",
      ].join("\n"),
    );
  }

  // メインセッション向け: 申し送り事項の読み込み・注入
  if (schedule.session_mode === "main") {
    const handoffs = await readTodayHandoffs(config.handoffsDir);
    if (handoffs.length > 0) {
      parts.push(
        "## 自動実行タスクの報告\n\n以下は、別セッションで自動実行されたスケジュールタスクの実行報告です。マスターに共有すべき内容があれば適宜伝えてください。\n\n" +
          handoffs.join("\n\n---\n\n"),
      );
    }
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
  eventBus?: SqliteEventBus,
): Promise<string> {
  console.log(
    `[scheduler] Running schedule: ${schedule.name} (session_mode=${schedule.session_mode})`,
  );
  const startTime = Date.now();

  try {
    const prompt = await buildPrompt(schedule, config, eventBus);
    const sessionTarget: SessionTarget | undefined =
      schedule.session_mode === "isolated"
        ? { mode: "isolated", scheduleName: schedule.name }
        : undefined;
    const result = await sendToClaude(prompt, config, {
      bypassMode: settings["bypass-mode"],
      source: "scheduler",
      sessionTarget,
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
  eventBus?: SqliteEventBus,
): Promise<string> {
  const schedule = settings.schedules.find((s) => s.name === name);
  if (!schedule) {
    const available = settings.schedules.map((s) => s.name).join(", ");
    throw new Error(`Schedule "${name}" not found. Available: ${available || "(none)"}`);
  }

  return runSchedule(schedule, settings, config, eventBus);
}
