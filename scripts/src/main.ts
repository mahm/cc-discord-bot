import { randomUUID } from "node:crypto";
import { applyBotSettingsToConfig, loadConfig } from "./adapters/config-adapter";
import { createBot } from "./adapters/discord-adapter";
import { createEventRuntime } from "./adapters/event-runtime";
import {
  loadBotSettings,
  runScheduleByName,
  startSchedulerWithPublisher,
} from "./adapters/scheduler-adapter";
import { prepareDmFiles } from "./adapters/send-dm-adapter";
import {
  BOT_EVENT_DM_RECOVER_RUN,
  BOT_EVENT_OUTBOUND_DM_REQUEST,
  BOT_EVENT_SCHEDULER_TRIGGERED,
  type DmRecoverRunEventPayload,
  type OutboundDmRequestPayload,
} from "./core/bot-events";
import { createDiscordConnectionManager } from "./core/discord-connection";
import { SqliteEventBus } from "./core/event-bus";
import { parseSendCommandArgs, SEND_USAGE } from "./core/send-command";

const config = loadConfig();

const subcommand = process.argv[2];

if (subcommand === "send") {
  // DM送信モード: bun run src/main.ts send <userId> [--file <path>]... [message]
  const parsed = parseSendCommandArgs(process.argv.slice(3));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(parsed.usage);
    process.exit(1);
  }

  try {
    const preparedFiles = await prepareDmFiles(parsed.value.filePaths, config.projectRoot);
    const eventBus = new SqliteEventBus(config.eventBusDbFile);
    const requestId = randomUUID();

    eventBus.publish({
      type: BOT_EVENT_OUTBOUND_DM_REQUEST,
      lane: "interactive",
      payload: {
        requestId,
        source: "manual_send",
        userId: parsed.value.userId,
        text: parsed.value.message,
        files: preparedFiles.map((file) => ({
          path: file.resolvedPath,
          name: file.fileName,
        })),
        context: `manual_send:user=${parsed.value.userId}`,
      } satisfies OutboundDmRequestPayload,
      priority: 30,
      dedupeKey: `manual_send:${requestId}`,
    });
    eventBus.close();

    console.log(
      `DM request queued (request_id=${requestId}, user=${parsed.value.userId}, files=${preparedFiles.length})`,
    );
  } catch (error) {
    console.error(`Failed to queue DM: ${error}`);
    console.error(SEND_USAGE);
    process.exit(1);
  }
} else if (subcommand === "schedule") {
  // 手動実行モード: bun run src/main.ts schedule <name>
  const name = process.argv[3];

  if (!name) {
    console.error("Usage: bun run main.ts schedule <name>");
    process.exit(1);
  }

  try {
    const settings = await loadBotSettings(config);
    applyBotSettingsToConfig(config, settings);
    const result = await runScheduleByName(name, settings, config);
    console.log(result);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {
  // Bot常駐モード(デフォルト): bun run src/main.ts
  const settings = await loadBotSettings(config);
  applyBotSettingsToConfig(config, settings);
  const eventBus = new SqliteEventBus(config.eventBusDbFile);
  const client = createBot(config, { eventBus });
  const heartbeatIntervalMs = settings.discord_connection_heartbeat_interval_seconds * 1000;
  const reconnectGraceMs = settings.discord_connection_reconnect_grace_seconds * 1000;
  const connection = createDiscordConnectionManager(client, config.discordBotToken, {
    heartbeatIntervalMs,
    reconnectGraceMs,
  });
  const runtime = createEventRuntime({
    client,
    config,
    bypassMode: settings["bypass-mode"],
    connection,
    eventBus,
  });
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Shutting down... (signal=${signal})`);
    runtime.stop();
    await connection.stop();
    eventBus.close();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const enqueueRecovery = (reason: string): void => {
    try {
      eventBus.publish({
        type: BOT_EVENT_DM_RECOVER_RUN,
        lane: "recovery",
        payload: {
          reason,
          triggeredAt: Date.now(),
        } satisfies DmRecoverRunEventPayload,
        priority: 10,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[event-bus] Failed to enqueue recovery run: ${errorMessage}`);
    }
  };

  client.on("clientReady", () => {
    enqueueRecovery("client_ready");
  });

  await connection.start();
  runtime.start();

  console.log("Discord daemon started");
  console.log(`Allowed users: ${config.allowedUserIds.join(", ")}`);
  console.log(`Project root: ${config.projectRoot}`);
  console.log(`Bypass mode: ${settings["bypass-mode"] ?? false}`);
  console.log(`Claude timeout (seconds): ${settings.claude_timeout_seconds}`);
  console.log(
    `Connection heartbeat (seconds): ${settings.discord_connection_heartbeat_interval_seconds}`,
  );
  console.log(
    `Connection reconnect grace (seconds): ${settings.discord_connection_reconnect_grace_seconds}`,
  );
  console.log(`Discord connected: ${connection.isReady()}`);
  console.log(`Event bus DB: ${config.eventBusDbFile}`);

  // Start scheduler
  startSchedulerWithPublisher(settings, (payload) => {
    try {
      eventBus.publish({
        type: BOT_EVENT_SCHEDULER_TRIGGERED,
        lane: "scheduled",
        payload,
        priority: 0,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[event-bus] Failed to enqueue schedule trigger: ${errorMessage}`);
    }
  });
}
