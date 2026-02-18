import { Client, type DMChannel, GatewayIntentBits, type Message, Partials } from "discord.js";
import { EMPTY_RESPONSE_FALLBACK_MESSAGE, sendChunksWithFallback } from "../core/message-format";
import {
  AttachmentError,
  cleanupExpiredAttachments,
  collectMessageAttachments,
} from "./attachments-adapter";
import { clearSession, getSessionId, sendToClaude } from "./claude-adapter";
import type { Config } from "./config-adapter";

export interface BotOptions {
  bypassMode?: boolean;
}

async function processQueuedMessage(
  message: Message,
  config: Config,
  options?: BotOptions,
): Promise<void> {
  const content = message.content.trim();
  const hasAttachments = message.attachments.size > 0;
  if (!content && !hasAttachments) return;

  const channel = message.channel as DMChannel;

  if (content === "!reset") {
    await clearSession(config);
    await channel.send("Session cleared. Starting fresh conversation.");
    console.log("Session reset by user");
    return;
  }

  if (content === "!session") {
    const sessionId = await getSessionId(config);
    if (sessionId) {
      await channel.send(`Current session: \`${sessionId}\``);
    } else {
      await channel.send("No active session.");
    }
    return;
  }

  await message.react("\u{1F440}").catch(() => {}); // 👀

  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 9000);
  await channel.sendTyping().catch(() => {});

  try {
    await cleanupExpiredAttachments(config).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[attachments] Cleanup failed: ${errorMessage}`);
    });

    const attachments = await collectMessageAttachments(message, config);
    const preview = content ? content.slice(0, 100) : "(no text)";
    console.log(
      `Processing message from ${message.author.tag}: ${preview} (attachments=${attachments.length})`,
    );

    const result = await sendToClaude(content, config, {
      bypassMode: options?.bypassMode,
      attachments,
      source: "dm",
      authorId: message.author.id,
    });

    await sendChunksWithFallback((chunk) => channel.send(chunk), result.response, {
      fallbackMessage: EMPTY_RESPONSE_FALLBACK_MESSAGE,
      source: "dm",
      context: `user=${message.author.id}`,
    });

    await message.react("\u2705").catch(() => {}); // ✅
    console.log(`Response sent (${result.response.length} chars, session: ${result.sessionId})`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error processing message: ${errorMessage}`);

    const userErrorMessage =
      error instanceof AttachmentError
        ? `Attachment error: ${error.message}`
        : `Error: ${errorMessage}`;

    await message.react("\u274C").catch(() => {}); // ❌

    await channel.send(userErrorMessage.slice(0, 1900)).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

export function createBot(config: Config, options?: BotOptions): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // Required for DM events
  });

  const queue: Message[] = [];
  let workerRunning = false;

  client.on("clientReady", () => {
    console.log(`Bot connected as ${client.user?.tag}`);
    cleanupExpiredAttachments(config).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[attachments] Initial cleanup failed: ${errorMessage}`);
    });
  });

  const runQueue = async (): Promise<void> => {
    if (workerRunning) return;
    workerRunning = true;

    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) continue;
        await processQueuedMessage(next, config, options);
      }
    } finally {
      workerRunning = false;

      // Recover if new messages arrived while the worker was finishing.
      if (queue.length > 0) {
        void runQueue().catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[queue] Unexpected queue failure: ${errorMessage}`);
        });
      }
    }
  };

  client.on("messageCreate", async (message: Message) => {
    if (message.guild !== null) return;
    if (message.author.bot) return;

    if (!config.allowedUserIds.includes(message.author.id)) {
      console.log(
        `Ignored message from unauthorized user: ${message.author.tag} (${message.author.id})`,
      );
      return;
    }

    const content = message.content.trim();
    const hasAttachments = message.attachments.size > 0;
    if (!content && !hasAttachments) return;

    queue.push(message);

    if (workerRunning) {
      const channel = message.channel as DMChannel;
      await channel
        .send("Queued your message. It will be processed after the current task.")
        .catch(() => {});
    }

    void runQueue().catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[queue] Unexpected queue failure: ${errorMessage}`);
    });
  });

  return client;
}
