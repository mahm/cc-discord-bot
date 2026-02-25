import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Purpose: Relative path to bot runtime settings under the project root.
 * Unit: path string.
 * Impact: Changing this requires moving/renaming `.claude/settings.bot.json`.
 */
export const BOT_SETTINGS_RELATIVE_PATH = path.join(".claude", "settings.bot.json");

/**
 * Purpose: Lower bound for a single Claude invocation timeout.
 * Unit: seconds.
 * Impact: Lower values fail fast but can break long-running tasks.
 */
export const BOT_SETTINGS_MIN_TIMEOUT_SECONDS = 10;

/**
 * Purpose: Upper bound for a single Claude invocation timeout.
 * Unit: seconds.
 * Impact: Higher values tolerate long tasks but delay failure detection.
 */
export const BOT_SETTINGS_MAX_TIMEOUT_SECONDS = 7200;

/**
 * Purpose: Default timeout for a single Claude invocation when omitted in settings.
 * Unit: seconds.
 * Impact: Controls baseline responsiveness vs. tolerance for long jobs.
 */
export const BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS = 1800;

/**
 * Purpose: Lower bound for Discord connection heartbeat interval.
 * Unit: seconds.
 * Impact: Smaller values detect stale connections faster with higher overhead.
 */
export const DISCORD_CONNECTION_MIN_HEARTBEAT_INTERVAL_SECONDS = 10;

/**
 * Purpose: Upper bound for Discord connection heartbeat interval.
 * Unit: seconds.
 * Impact: Larger values reduce overhead but slow failure detection.
 */
export const DISCORD_CONNECTION_MAX_HEARTBEAT_INTERVAL_SECONDS = 300;

/**
 * Purpose: Default heartbeat interval for Discord connection health checks.
 * Unit: seconds.
 * Impact: Baseline cadence for connection monitoring and recovery decisions.
 */
export const DISCORD_CONNECTION_DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;

/**
 * Purpose: Lower bound for "stale gateway" detection threshold.
 * Unit: seconds.
 * Impact: Smaller values reconnect aggressively when events stall.
 */
export const DISCORD_CONNECTION_MIN_STALE_THRESHOLD_SECONDS = 30;

/**
 * Purpose: Upper bound for "stale gateway" detection threshold.
 * Unit: seconds.
 * Impact: Larger values reduce false positives but delay recovery.
 */
export const DISCORD_CONNECTION_MAX_STALE_THRESHOLD_SECONDS = 900;

/**
 * Purpose: Default threshold for deciding the Discord gateway is stale.
 * Unit: seconds.
 * Impact: Balances quick recovery and stability under transient stalls.
 */
export const DISCORD_CONNECTION_DEFAULT_STALE_THRESHOLD_SECONDS = 180;

/**
 * Purpose: Lower bound for reconnect grace period after reconnect attempt.
 * Unit: seconds.
 * Impact: Smaller values can trigger repeated reconnect loops.
 */
export const DISCORD_CONNECTION_MIN_RECONNECT_GRACE_SECONDS = 5;

/**
 * Purpose: Upper bound for reconnect grace period after reconnect attempt.
 * Unit: seconds.
 * Impact: Larger values increase tolerance but delay secondary recovery actions.
 */
export const DISCORD_CONNECTION_MAX_RECONNECT_GRACE_SECONDS = 120;

/**
 * Purpose: Default grace period to wait for `ready` after reconnect.
 * Unit: seconds.
 * Impact: Baseline waiting window before considering reconnect unhealthy.
 */
export const DISCORD_CONNECTION_DEFAULT_RECONNECT_GRACE_SECONDS = 20;

/**
 * Purpose: Polling interval for workers when no event is immediately available.
 * Unit: milliseconds.
 * Impact: Lower values reduce queue latency at the cost of more DB polling.
 */
export const EVENT_RUNTIME_POLL_INTERVAL_MS = 250;

/**
 * Purpose: Interval for periodic reconcile events.
 * Unit: milliseconds.
 * Impact: Lower values heal missing reactions faster but add background load.
 */
export const EVENT_RUNTIME_RECONCILE_INTERVAL_MS = 15_000;

/**
 * Purpose: Age threshold to treat a `processing` event as stale and requeue it.
 * Unit: milliseconds.
 * Impact: Lower values recover from stuck workers faster but may requeue slow jobs.
 */
export const EVENT_RUNTIME_STALE_LOCK_TIMEOUT_MS = 120_000;

/**
 * Purpose: Maximum retry attempts before moving an event to dead-letter status.
 * Unit: count.
 * Impact: Higher values improve transient recovery but can keep bad events longer.
 */
export const EVENT_RUNTIME_MAX_ATTEMPTS = 20;

/**
 * Purpose: Timeout for waiting Discord connection readiness inside worker loop.
 * Unit: milliseconds.
 * Impact: Larger values reduce wakeups but delay loop responsiveness when disconnected.
 */
export const EVENT_RUNTIME_CONNECTION_WAIT_TIMEOUT_MS = 60_000;

/**
 * Purpose: Number of dedicated workers for `session_mode: "isolated"` schedule lane.
 * Unit: count.
 * Impact: Higher values increase isolated throughput but also host resource pressure.
 */
export const SCHEDULED_ISOLATED_WORKER_COUNT = 2;

const scheduleSchema = z
  .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().min(1),
    prompt: z.string().min(1),
    discord_notify: z.boolean(),
    prompt_file: z.string().min(1).optional(),
    skippable: z.boolean().optional(),
    session_mode: z.enum(["main", "isolated"]).default("main"),
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
      .min(BOT_SETTINGS_MIN_TIMEOUT_SECONDS)
      .max(BOT_SETTINGS_MAX_TIMEOUT_SECONDS)
      .default(BOT_SETTINGS_DEFAULT_TIMEOUT_SECONDS),
    discord_connection_heartbeat_interval_seconds: z
      .number()
      .int()
      .min(DISCORD_CONNECTION_MIN_HEARTBEAT_INTERVAL_SECONDS)
      .max(DISCORD_CONNECTION_MAX_HEARTBEAT_INTERVAL_SECONDS)
      .default(DISCORD_CONNECTION_DEFAULT_HEARTBEAT_INTERVAL_SECONDS),
    discord_connection_stale_threshold_seconds: z
      .number()
      .int()
      .min(DISCORD_CONNECTION_MIN_STALE_THRESHOLD_SECONDS)
      .max(DISCORD_CONNECTION_MAX_STALE_THRESHOLD_SECONDS)
      .default(DISCORD_CONNECTION_DEFAULT_STALE_THRESHOLD_SECONDS),
    discord_connection_reconnect_grace_seconds: z
      .number()
      .int()
      .min(DISCORD_CONNECTION_MIN_RECONNECT_GRACE_SECONDS)
      .max(DISCORD_CONNECTION_MAX_RECONNECT_GRACE_SECONDS)
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

export async function loadBotSettings(projectRoot: string): Promise<BotSettings> {
  const settingsPath = path.join(projectRoot, BOT_SETTINGS_RELATIVE_PATH);
  const content = await readFile(settingsPath, "utf-8");
  return parseBotSettings(content);
}
