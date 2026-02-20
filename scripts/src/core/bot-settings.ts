import { z } from "zod";

export const BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS = 1800;
export const DISCORD_CONNECTION_DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
export const DISCORD_CONNECTION_DEFAULT_STALE_THRESHOLD_SECONDS = 180;
export const DISCORD_CONNECTION_DEFAULT_RECONNECT_GRACE_SECONDS = 20;

const scheduleSchema = z
  .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().min(1),
    prompt: z.string().min(1),
    discord_notify: z.boolean(),
    prompt_file: z.string().min(1).optional(),
    skippable: z.boolean().optional(),
  })
  .strict();

const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid env key format");

const botSettingsSchema = z
  .object({
    "bypass-mode": z.boolean().optional(),
    enable_sandbox: z.boolean().optional(),
    claude_timeout_seconds: z
      .number()
      .int()
      .min(10)
      .max(7200)
      .default(BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS),
    discord_connection_heartbeat_interval_seconds: z
      .number()
      .int()
      .min(10)
      .max(300)
      .default(DISCORD_CONNECTION_DEFAULT_HEARTBEAT_INTERVAL_SECONDS),
    discord_connection_stale_threshold_seconds: z
      .number()
      .int()
      .min(30)
      .max(900)
      .default(DISCORD_CONNECTION_DEFAULT_STALE_THRESHOLD_SECONDS),
    discord_connection_reconnect_grace_seconds: z
      .number()
      .int()
      .min(5)
      .max(120)
      .default(DISCORD_CONNECTION_DEFAULT_RECONNECT_GRACE_SECONDS),
    env: z.record(envKeySchema, z.string()).default({}),
    schedules: z.array(scheduleSchema).default([]),
  })
  .strict();

export type BotSettings = z.infer<typeof botSettingsSchema>;

export function parseBotSettings(input: string): BotSettings {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in .claude/settings.bot.json: ${message}`);
  }

  const result = botSettingsSchema.safeParse(parsedJson);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid .claude/settings.bot.json: ${details}`);
  }

  return result.data;
}
