import { Client, GatewayIntentBits } from "discord.js";
import { applyBotSettingsToConfig, loadConfig } from "./adapters/config-adapter";
import { createBot } from "./adapters/discord-adapter";
import { loadBotSettings, runScheduleByName, startScheduler } from "./adapters/scheduler-adapter";
import { prepareDmFiles } from "./adapters/send-dm-adapter";
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

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.discordBotToken);

  client.on("clientReady", async () => {
    try {
      const preparedFiles = await prepareDmFiles(parsed.value.filePaths, config.projectRoot);

      const user = await client.users.fetch(parsed.value.userId);
      await user.send({
        ...(parsed.value.message ? { content: parsed.value.message } : {}),
        ...(preparedFiles.length > 0
          ? {
              files: preparedFiles.map((file) => ({
                attachment: file.resolvedPath,
                name: file.fileName,
              })),
            }
          : {}),
      });
      console.log(`DM sent to ${user.tag} (files=${preparedFiles.length})`);
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      console.error(SEND_USAGE);
      process.exit(1);
    } finally {
      client.destroy();
    }
  });
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
  const client = createBot(config, {
    bypassMode: settings["bypass-mode"],
  });

  function shutdown() {
    console.log("Shutting down...");
    client.destroy();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  client.login(config.discordBotToken).then(async () => {
    console.log("Discord daemon started");
    console.log(`Allowed users: ${config.allowedUserIds.join(", ")}`);
    console.log(`Project root: ${config.projectRoot}`);
    console.log(`Bypass mode: ${settings["bypass-mode"] ?? false}`);
    console.log(`Claude timeout (seconds): ${settings.claude_timeout_seconds}`);

    // Start scheduler
    startScheduler(settings, config, client);
  });
}
