import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type DMChannel,
} from "discord.js";
import { sendToClaude, clearSession, getSessionId } from "./claude-bridge";
import type { Config } from "./config";

const DISCORD_MAX_LENGTH = 2000;

// Split message into chunks respecting Discord's 2000 char limit
export function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline within the limit
    let splitIndex = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitIndex <= 0) {
      // No newline found, try space
      splitIndex = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
    }
    if (splitIndex <= 0) {
      // No good break point, hard cut
      splitIndex = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export interface BotOptions {
  bypassMode?: boolean;
}

export function createBot(config: Config, options?: BotOptions): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // Required for DM events
  });

  // Mutex for exclusive Claude access
  let processing = false;

  client.on("clientReady", () => {
    console.log(`Bot connected as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore guild messages (only respond to DMs)
    if (message.guild !== null) return;

    // Ignore bot messages
    if (message.author.bot) return;

    // Check if user is allowed
    if (!config.allowedUserIds.includes(message.author.id)) {
      console.log(`Ignored message from unauthorized user: ${message.author.tag} (${message.author.id})`);
      return;
    }

    const content = message.content.trim();
    if (!content) return;

    const channel = message.channel as DMChannel;

    // Handle !reset command
    if (content === "!reset") {
      await clearSession(config);
      await channel.send("Session cleared. Starting fresh conversation.");
      console.log("Session reset by user");
      return;
    }

    // Handle !session command
    if (content === "!session") {
      const sessionId = await getSessionId(config);
      if (sessionId) {
        await channel.send(`Current session: \`${sessionId}\``);
      } else {
        await channel.send("No active session.");
      }
      return;
    }

    // Check exclusive lock
    if (processing) {
      await channel.send("Processing previous message... Please wait.");
      return;
    }

    processing = true;

    // React to acknowledge receipt
    await message.react("\u{1F440}").catch(() => {}); // 👀

    // Start typing indicator (repeats every 9 seconds)
    const typingInterval = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 9000);
    // Send initial typing indicator
    await channel.sendTyping().catch(() => {});

    try {
      console.log(`Processing message from ${message.author.tag}: ${content.slice(0, 100)}`);

      const result = await sendToClaude(content, config, {
        bypassMode: options?.bypassMode,
      });

      // Stop typing indicator
      clearInterval(typingInterval);

      // Split and send response
      const chunks = splitMessage(result.response);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }

      // React to indicate completion
      await message.react("\u2705").catch(() => {}); // ✅

      console.log(`Response sent (${result.response.length} chars, session: ${result.sessionId})`);
    } catch (error) {
      clearInterval(typingInterval);

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`Error processing message: ${errorMessage}`);

      // React to indicate error
      await message.react("\u274C").catch(() => {}); // ❌

      await channel
        .send(`Error: ${errorMessage.slice(0, 1900)}`)
        .catch(() => {});
    } finally {
      processing = false;
    }
  });

  return client;
}
