import { Client, GatewayIntentBits, type Message, Partials } from "discord.js";
import { BOT_EVENT_DM_INCOMING, type DmIncomingEventPayload } from "../core/bot-events";
import type { SqliteEventBus } from "../core/event-bus";
import type { Config } from "./config-adapter";

export interface BotOptions {
  bypassMode?: boolean;
  eventBus: SqliteEventBus;
}

function canProcessMessage(message: Message, config: Config): boolean {
  if (message.guild !== null) return false;
  if (message.author.bot) return false;
  if (!config.allowedUserIds.includes(message.author.id)) {
    console.log(
      `Ignored message from unauthorized user: ${message.author.tag} (${message.author.id})`,
    );
    return false;
  }

  const content = message.content.trim();
  const hasAttachments = message.attachments.size > 0;
  return content.length > 0 || hasAttachments;
}

export function createBot(config: Config, options: BotOptions): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  client.on("clientReady", () => {
    console.log(`Bot connected as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message: Message) => {
    if (!canProcessMessage(message, config)) {
      return;
    }

    const payload: DmIncomingEventPayload = {
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
    };

    try {
      options.eventBus.publish({
        type: BOT_EVENT_DM_INCOMING,
        lane: "interactive",
        payload,
        priority: 20,
      });
      options.eventBus.updateDmOffset(`dm_user:${message.author.id}`, message.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[event-bus] Failed to enqueue dm.incoming: ${errorMessage}`);
    }
  });

  return client;
}
