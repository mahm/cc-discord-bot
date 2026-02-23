import type { Client, DMChannel, Message } from "discord.js";
import {
  BOT_EVENT_DM_INCOMING,
  BOT_EVENT_DM_RECONCILE_RUN,
  BOT_EVENT_DM_RECOVER_RUN,
  BOT_EVENT_OUTBOUND_DM_REQUEST,
  BOT_EVENT_SCHEDULER_TRIGGERED,
  type DmIncomingEventPayload,
  type DmReconcileRunEventPayload,
  type DmRecoverRunEventPayload,
  type OutboundDmRequestPayload,
  SCHEDULER_EVENT_TTL_MS,
  type SchedulerTriggeredEventPayload,
} from "../core/bot-events";
import { runWithEmptyResponseRetry } from "../core/claude-retry";
import { classifyDiscordError, isTerminalDiscordError } from "../core/discord-errors";
import { type EventBusEvent, SqliteEventBus } from "../core/event-bus";
import { isSkipResponse, sendChunksWithFallback, splitMessage } from "../core/message-format";
import { resolveOutboundDmDeliveryPolicy } from "../core/outbound-dm-policy";
import {
  AttachmentError,
  cleanupExpiredAttachments,
  collectMessageAttachments,
} from "./attachments-adapter";
import { clearSession, getSessionId, isClaudeAuthError, sendToClaude } from "./claude-adapter";
import type { Config } from "./config-adapter";
import { loadBotSettings, runScheduleByName } from "./scheduler-adapter";

const EYE_EMOJI = "\u{1F440}";
const CHECK_EMOJI = "\u2705";
const ERROR_EMOJI = "\u274C";
const RECONCILE_INTERVAL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const STALE_LOCK_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 20;

type ConnectionGuard = {
  isReady(): boolean;
  waitUntilReady(timeoutMs?: number): Promise<boolean>;
};

class RetryableEventError extends Error {
  constructor(
    message: string,
    readonly delayMs?: number,
  ) {
    super(message);
    this.name = "RetryableEventError";
  }
}

class TerminalEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalEventError";
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareSnowflakeAsc(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  } catch {
    return left.localeCompare(right);
  }
}

function isDmIncomingPayload(payload: unknown): payload is DmIncomingEventPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const maybe = payload as Partial<DmIncomingEventPayload>;
  return (
    typeof maybe.messageId === "string" &&
    typeof maybe.channelId === "string" &&
    typeof maybe.authorId === "string"
  );
}

function isOutboundDmPayload(payload: unknown): payload is OutboundDmRequestPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const maybe = payload as Partial<OutboundDmRequestPayload>;
  const hasTarget = typeof maybe.userId === "string" || typeof maybe.channelId === "string";
  return typeof maybe.requestId === "string" && typeof maybe.text === "string" && hasTarget;
}

function isSchedulerTriggeredPayload(payload: unknown): payload is SchedulerTriggeredEventPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const maybe = payload as Partial<SchedulerTriggeredEventPayload>;
  if (typeof maybe.scheduleName !== "string") {
    return false;
  }
  if (typeof maybe.triggeredAt !== "number" || !Number.isFinite(maybe.triggeredAt)) {
    return false;
  }
  if (maybe.expiresAt !== undefined && !Number.isFinite(maybe.expiresAt)) {
    return false;
  }
  return true;
}

function isRecoverPayload(payload: unknown): payload is DmRecoverRunEventPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const maybe = payload as Partial<DmRecoverRunEventPayload>;
  return typeof maybe.reason === "string";
}

function isReconcilePayload(payload: unknown): payload is DmReconcileRunEventPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const maybe = payload as Partial<DmReconcileRunEventPayload>;
  return typeof maybe.reason === "string";
}

function classifyDmIncomingError(error: unknown): "terminal" | "retryable" {
  if (error instanceof TerminalEventError) {
    return "terminal";
  }
  if (error instanceof RetryableEventError) {
    return "retryable";
  }
  return classifyDiscordError(error);
}

async function fetchDmMessage(
  client: Client,
  channelId: string,
  messageId: string,
): Promise<Message<boolean>> {
  let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    if (isTerminalDiscordError(error)) {
      throw new TerminalEventError(errorMessage);
    }
    throw new RetryableEventError(errorMessage);
  }

  if (!channel || !channel.isDMBased()) {
    throw new TerminalEventError(`DM channel not found: ${channelId}`);
  }

  try {
    const message = await channel.messages.fetch(messageId);
    if (!message) {
      throw new TerminalEventError(`Message not found: ${messageId}`);
    }
    return message;
  } catch (error) {
    if (error instanceof TerminalEventError) {
      throw error;
    }
    const errorMessage = toErrorMessage(error);
    if (isTerminalDiscordError(error)) {
      throw new TerminalEventError(errorMessage);
    }
    throw new RetryableEventError(errorMessage);
  }
}

async function sendUserMessageWithOptionalFiles(
  sender: (
    input: string | { content?: string; files?: Array<{ attachment: string; name: string }> },
  ) => Promise<unknown>,
  text: string,
  files: Array<{ path: string; name: string }>,
  options: {
    source: "dm" | "scheduler";
    fallbackMessage?: string;
    context?: string;
  },
): Promise<void> {
  const normalizedFiles = files.filter((file) => file.path.trim().length > 0);
  if (normalizedFiles.length === 0) {
    await sendChunksWithFallback((chunk) => sender(chunk), text, options);
    return;
  }

  const chunks = splitMessage(text).filter((chunk) => chunk.trim().length > 0);
  const firstChunk = chunks.shift();
  await sender({
    ...(firstChunk ? { content: firstChunk } : {}),
    files: normalizedFiles.map((file) => ({ attachment: file.path, name: file.name })),
  });

  for (const chunk of chunks) {
    await sender({ content: chunk });
  }
}

export interface EventRuntime {
  start(): void;
  stop(): void;
}

interface CreateEventRuntimeInput {
  client: Client;
  config: Config;
  bypassMode?: boolean;
  connection: ConnectionGuard;
  eventBus: SqliteEventBus;
}

export function createEventRuntime(input: CreateEventRuntimeInput): EventRuntime {
  const workerId = `runtime-${process.pid}`;
  let running = false;
  let workerPromise: Promise<void> | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let waitingForConnection = false;

  async function enqueueReconcile(reason: string): Promise<void> {
    input.eventBus.publish({
      type: BOT_EVENT_DM_RECONCILE_RUN,
      lane: "system",
      payload: {
        reason,
        triggeredAt: Date.now(),
      } satisfies DmReconcileRunEventPayload,
      priority: -1,
    });
  }

  function enqueueDmIncoming(
    payload: DmIncomingEventPayload,
    lane: "interactive" | "recovery",
    priority: number,
  ): void {
    input.eventBus.publish({
      type: BOT_EVENT_DM_INCOMING,
      lane,
      payload,
      priority,
    });
  }

  function enqueueDmIncomingIfIdle(
    entry: Pick<DmIncomingEventPayload, "messageId" | "channelId" | "authorId">,
    lane: "interactive" | "recovery",
    priority: number,
  ): void {
    if (input.eventBus.hasActiveDmIncomingEvent(entry.messageId)) {
      return;
    }
    enqueueDmIncoming(
      {
        messageId: entry.messageId,
        channelId: entry.channelId,
        authorId: entry.authorId,
      },
      lane,
      priority,
    );
  }

  async function handleOutboundDmRequest(payload: OutboundDmRequestPayload): Promise<void> {
    const files = (payload.files ?? []).map((file) => ({
      path: String(file.path ?? ""),
      name: String(file.name ?? "file"),
    }));
    const deliveryPolicy = resolveOutboundDmDeliveryPolicy(payload.source);

    if (payload.channelId) {
      const channel = await input.client.channels.fetch(payload.channelId);
      if (!channel || !channel.isDMBased()) {
        throw new TerminalEventError(`DM channel not found: ${payload.channelId}`);
      }
      if (!("send" in channel) || typeof channel.send !== "function") {
        throw new TerminalEventError(`DM channel is not sendable: ${payload.channelId}`);
      }

      await sendChunksWithFallback((chunk) => channel.send(chunk), payload.text, {
        ...deliveryPolicy,
        context: payload.context,
      });
      return;
    }

    const userId = payload.userId;
    if (!userId) {
      throw new TerminalEventError("outbound.dm.request requires userId or channelId");
    }
    const user = await input.client.users.fetch(userId);
    await sendUserMessageWithOptionalFiles((message) => user.send(message), payload.text, files, {
      ...deliveryPolicy,
      context: payload.context,
    });
  }

  async function processDmMessage(message: Message<boolean>): Promise<void> {
    const channel = message.channel as DMChannel;
    const content = message.content.trim();
    const hasAttachments = message.attachments.size > 0;
    if (!content && !hasAttachments) {
      return;
    }

    if (content === "!reset") {
      await clearSession(input.config);
      await channel.send("Session cleared. Starting fresh conversation.");
      console.log("Session reset by user");
      return;
    }

    if (content === "!session") {
      const sessionId = await getSessionId(input.config);
      if (sessionId) {
        await channel.send(`Current session: \`${sessionId}\``);
      } else {
        await channel.send("No active session.");
      }
      return;
    }

    const typingInterval = setInterval(() => {
      channel.sendTyping().catch((error) => {
        console.warn(`[discord] sendTyping failed: ${toErrorMessage(error)}`);
      });
    }, 9000);
    await channel.sendTyping().catch((error) => {
      console.warn(`[discord] sendTyping failed: ${toErrorMessage(error)}`);
    });

    try {
      await cleanupExpiredAttachments(input.config).catch((error) => {
        console.warn(`[attachments] Cleanup failed: ${toErrorMessage(error)}`);
      });

      const attachments = await collectMessageAttachments(message, input.config);
      const preview = content ? content.slice(0, 100) : "(no text)";
      console.log(
        `Processing message from ${message.author.tag}: ${preview} (attachments=${attachments.length})`,
      );

      const { result, attempts } = await runWithEmptyResponseRetry(
        async () =>
          await sendToClaude(content, input.config, {
            bypassMode: input.bypassMode,
            attachments,
            source: "dm",
            authorId: message.author.id,
          }),
        {
          source: "dm",
          context: `user=${message.author.id}`,
        },
      );

      if (attempts > 1) {
        console.log(
          `[claude-retry] Recovered non-empty response after ${attempts} attempts (user=${message.author.id})`,
        );
      }

      input.eventBus.publish({
        type: BOT_EVENT_OUTBOUND_DM_REQUEST,
        lane: "interactive",
        payload: {
          requestId: `${message.id}:reply`,
          source: "dm_reply",
          channelId: channel.id,
          text: result.response,
          context: `user=${message.author.id}`,
        } satisfies OutboundDmRequestPayload,
        priority: 20,
        dedupeKey: `outbound:${message.id}:reply`,
      });

      console.log(
        `Response queued (${result.response.length} chars, session: ${result.sessionId}, attempts=${attempts})`,
      );
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      console.error(`Error processing message: ${errorMessage}`);

      let userErrorMessage: string;
      if (isClaudeAuthError(error)) {
        userErrorMessage = [
          "⚠️ Claude Code の認証が切れています。",
          "",
          "以下の手順で復旧してください:",
          "1. `tmux kill-session -t cc-discord-bot` で Bot を停止",
          `2. \`docker sandbox run --workspace ${input.config.projectRoot} claude\` で対話モードに入る`,
          "3. `/login` でログイン（ブラウザが開きます）",
          '4. Ctrl+C で終了後、Bot を再起動: `tmux new -d -s cc-discord-bot "bun run .claude/skills/cc-discord-bot/scripts/src/main.ts"`',
        ].join("\n");
      } else if (error instanceof AttachmentError) {
        userErrorMessage = `添付ファイルのエラー: ${error.message}`;
      } else {
        userErrorMessage = `Error: ${errorMessage}`;
      }

      input.eventBus.publish({
        type: BOT_EVENT_OUTBOUND_DM_REQUEST,
        lane: "interactive",
        payload: {
          requestId: `${message.id}:error`,
          source: isClaudeAuthError(error) ? "auth_error" : "dm_reply",
          channelId: channel.id,
          text: userErrorMessage.slice(0, 1900),
          context: `user=${message.author.id},error=true`,
        } satisfies OutboundDmRequestPayload,
        priority: 25,
        dedupeKey: `outbound:${message.id}:error`,
      });

      throw new TerminalEventError(errorMessage);
    } finally {
      clearInterval(typingInterval);
    }
  }

  function markDmTerminalFailureIfNeeded(
    messageId: string,
    errorMessage: string,
    reason: string,
  ): void {
    const current = input.eventBus.getDmMessageState(messageId);
    if (current?.terminalFailed) {
      return;
    }
    input.eventBus.markDmTerminalFailure(messageId, errorMessage);
    console.error(`[dm.incoming] terminal message=${messageId} reason=${reason}: ${errorMessage}`);
  }

  async function handleDmIncoming(payload: DmIncomingEventPayload): Promise<void> {
    input.eventBus.upsertDmMessage(payload.messageId, payload.channelId, payload.authorId);
    const state = input.eventBus.getDmMessageState(payload.messageId);
    if (!state || state.terminalFailed) {
      return;
    }

    try {
      const message = await fetchDmMessage(input.client, payload.channelId, payload.messageId);

      if (!state.eyeApplied) {
        try {
          await message.react(EYE_EMOJI);
          input.eventBus.markEyeApplied(payload.messageId);
        } catch (error) {
          const errorMessage = toErrorMessage(error);
          console.warn(
            `[discord] 👀 reaction failed message=${payload.messageId}: ${errorMessage}`,
          );
          if (isTerminalDiscordError(error)) {
            throw new TerminalEventError(errorMessage);
          }
          throw new RetryableEventError(errorMessage);
        }
      }

      const refreshed = input.eventBus.getDmMessageState(payload.messageId);
      if (!refreshed || refreshed.terminalFailed) {
        return;
      }

      if (!refreshed.processingDone) {
        try {
          await processDmMessage(message);
          input.eventBus.markProcessingDone(payload.messageId);
        } catch (error) {
          const errorMessage = toErrorMessage(error);
          input.eventBus.setDmLastError(payload.messageId, errorMessage);
          if (error instanceof RetryableEventError) {
            throw error;
          }

          try {
            await message.react(ERROR_EMOJI);
          } catch (reactError) {
            console.warn(
              `[discord] ❌ reaction failed message=${payload.messageId}: ${toErrorMessage(reactError)}`,
            );
          }
          if (error instanceof TerminalEventError) {
            throw error;
          }
          throw new TerminalEventError(errorMessage);
        }
      }

      const postProcessing = input.eventBus.getDmMessageState(payload.messageId);
      if (!postProcessing || postProcessing.terminalFailed || postProcessing.checkApplied) {
        return;
      }

      try {
        await message.react(CHECK_EMOJI);
        input.eventBus.markCheckApplied(payload.messageId);
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        console.warn(`[discord] ✅ reaction failed message=${payload.messageId}: ${errorMessage}`);
        if (isTerminalDiscordError(error)) {
          throw new TerminalEventError(errorMessage);
        }
        throw new RetryableEventError(errorMessage);
      }
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      input.eventBus.setDmLastError(payload.messageId, errorMessage);
      const classification = classifyDmIncomingError(error);
      if (classification === "terminal") {
        markDmTerminalFailureIfNeeded(
          payload.messageId,
          errorMessage,
          error instanceof TerminalEventError ? error.message : "classified_terminal",
        );
        if (error instanceof TerminalEventError) {
          throw error;
        }
        throw new TerminalEventError(errorMessage);
      }
      if (error instanceof RetryableEventError) {
        throw error;
      }
      throw new RetryableEventError(errorMessage);
    }
  }

  async function handleSchedulerTriggered(payload: SchedulerTriggeredEventPayload): Promise<void> {
    const now = Date.now();
    const expiresAt =
      typeof payload.expiresAt === "number" && Number.isFinite(payload.expiresAt)
        ? payload.expiresAt
        : payload.triggeredAt + SCHEDULER_EVENT_TTL_MS;

    if (expiresAt <= now) {
      console.warn(
        `[scheduler] Skip expired trigger (schedule=${payload.scheduleName}, triggered_at=${payload.triggeredAt}, expires_at=${expiresAt}, now=${now})`,
      );
      return;
    }

    const settings = await loadBotSettings(input.config);
    const schedule = settings.schedules.find((entry) => entry.name === payload.scheduleName);
    if (!schedule) {
      throw new TerminalEventError(`Schedule not found: ${payload.scheduleName}`);
    }

    const response = await runScheduleByName(
      payload.scheduleName,
      settings,
      input.config,
      input.eventBus,
    );
    const shouldSkip = schedule.skippable && isSkipResponse(response);
    if (shouldSkip || !schedule.discord_notify) {
      return;
    }

    const targetUserId = input.config.allowedUserIds[0];
    input.eventBus.publish({
      type: BOT_EVENT_OUTBOUND_DM_REQUEST,
      lane: "scheduled",
      payload: {
        requestId: `schedule:${payload.scheduleName}:${payload.triggeredAt}`,
        source: "scheduler",
        userId: targetUserId,
        text: response,
        context: `schedule=${payload.scheduleName},user=${targetUserId}`,
      } satisfies OutboundDmRequestPayload,
      priority: 0,
      dedupeKey: `outbound:schedule:${payload.scheduleName}:${payload.triggeredAt}`,
    });
  }

  async function handleRecoveryRun(payload: DmRecoverRunEventPayload): Promise<void> {
    console.log(`[recovery] Start reason=${payload.reason}`);

    for (const userId of input.config.allowedUserIds) {
      const scope = `dm_user:${userId}`;
      let cursor = input.eventBus.getDmOffset(scope);
      const user = await input.client.users.fetch(userId);
      const dmChannel = await user.createDM();

      if (!cursor) {
        const latest = await dmChannel.messages.fetch({ limit: 1 });
        const latestMessage = latest.first();
        if (latestMessage) {
          input.eventBus.updateDmOffset(scope, latestMessage.id);
          console.log(
            `[recovery] Initialized offset scope=${scope} latest_message_id=${latestMessage.id}`,
          );
        } else {
          console.log(`[recovery] Initialized offset scope=${scope} (no existing messages)`);
        }
        continue;
      }

      while (true) {
        const batch: Awaited<ReturnType<typeof dmChannel.messages.fetch>> =
          await dmChannel.messages.fetch({
            limit: 100,
            ...(cursor ? { after: cursor } : {}),
          });
        if (batch.size === 0) {
          break;
        }

        const ordered: Message<boolean>[] = [...batch.values()].sort((left, right) =>
          compareSnowflakeAsc(left.id, right.id),
        );
        for (const message of ordered) {
          input.eventBus.updateDmOffset(scope, message.id);

          if (message.author.bot) {
            continue;
          }
          if (message.author.id !== userId) {
            continue;
          }

          const content = message.content.trim();
          const hasAttachments = message.attachments.size > 0;
          if (!content && !hasAttachments) {
            continue;
          }

          const existing = input.eventBus.getDmMessageState(message.id);
          if (existing?.processingDone || existing?.terminalFailed) {
            continue;
          }
          enqueueDmIncomingIfIdle(
            {
              messageId: message.id,
              channelId: message.channelId,
              authorId: message.author.id,
            },
            "recovery",
            5,
          );
        }

        const newest: Message<boolean> | undefined = ordered[ordered.length - 1];
        cursor = newest?.id ?? cursor;
        if (batch.size < 100) {
          break;
        }
      }
    }
    console.log("[recovery] Completed");
  }

  async function handleReconcileRun(payload: DmReconcileRunEventPayload): Promise<void> {
    const missingEye = input.eventBus.listDmMissingEye(50);
    const missingCheck = input.eventBus.listDmMissingCheck(50);

    for (const entry of missingEye) {
      const latest = input.eventBus.getDmMessageState(entry.messageId);
      if (!latest || latest.terminalFailed || latest.eyeApplied) {
        continue;
      }
      enqueueDmIncomingIfIdle(entry, "interactive", 15);
    }

    for (const entry of missingCheck) {
      const latest = input.eventBus.getDmMessageState(entry.messageId);
      if (!latest || latest.terminalFailed || !latest.processingDone || latest.checkApplied) {
        continue;
      }
      enqueueDmIncomingIfIdle(entry, "interactive", 15);
    }

    if (missingEye.length > 0 || missingCheck.length > 0) {
      console.log(
        `[reconcile] reason=${payload.reason} missing_eye=${missingEye.length} missing_check=${missingCheck.length}`,
      );
    }
  }

  async function handleEvent(event: EventBusEvent): Promise<void> {
    switch (event.type) {
      case BOT_EVENT_DM_INCOMING: {
        if (!isDmIncomingPayload(event.payload)) {
          throw new TerminalEventError("Invalid payload for dm.incoming");
        }
        await handleDmIncoming(event.payload);
        return;
      }
      case BOT_EVENT_OUTBOUND_DM_REQUEST: {
        if (!isOutboundDmPayload(event.payload)) {
          throw new TerminalEventError("Invalid payload for outbound.dm.request");
        }
        await handleOutboundDmRequest(event.payload);
        return;
      }
      case BOT_EVENT_SCHEDULER_TRIGGERED: {
        if (!isSchedulerTriggeredPayload(event.payload)) {
          throw new TerminalEventError("Invalid payload for scheduler.triggered");
        }
        await handleSchedulerTriggered(event.payload);
        return;
      }
      case BOT_EVENT_DM_RECOVER_RUN: {
        if (!isRecoverPayload(event.payload)) {
          throw new TerminalEventError("Invalid payload for dm.recover.run");
        }
        await handleRecoveryRun(event.payload);
        return;
      }
      case BOT_EVENT_DM_RECONCILE_RUN: {
        if (!isReconcilePayload(event.payload)) {
          throw new TerminalEventError("Invalid payload for dm.reconcile.run");
        }
        await handleReconcileRun(event.payload);
        return;
      }
      default:
        throw new TerminalEventError(`Unsupported event type: ${event.type}`);
    }
  }

  function settleDmIncomingTerminalFailure(
    event: EventBusEvent,
    errorMessage: string,
    reason: string,
  ): void {
    if (event.type !== BOT_EVENT_DM_INCOMING) {
      return;
    }
    if (!isDmIncomingPayload(event.payload)) {
      return;
    }
    input.eventBus.upsertDmMessage(
      event.payload.messageId,
      event.payload.channelId,
      event.payload.authorId,
    );
    markDmTerminalFailureIfNeeded(event.payload.messageId, errorMessage, reason);
  }

  async function runWorkerLoop(): Promise<void> {
    while (running) {
      if (!input.connection.isReady()) {
        if (!waitingForConnection) {
          waitingForConnection = true;
          console.warn("[event-bus] Connection not ready. Pausing event processing.");
        }

        const ready = await input.connection.waitUntilReady(60_000);
        if (!running) {
          break;
        }
        if (!ready) {
          continue;
        }
      }

      if (waitingForConnection) {
        waitingForConnection = false;
        console.log("[event-bus] Connection recovered. Resuming event processing.");
      }

      const requeued = input.eventBus.requeueStaleProcessing(STALE_LOCK_TIMEOUT_MS);
      if (requeued > 0) {
        console.warn(`[event-bus] Requeued stale events: ${requeued}`);
      }

      const event = input.eventBus.claimNext(workerId);
      if (!event) {
        await wait(DEFAULT_POLL_INTERVAL_MS);
        continue;
      }

      try {
        await handleEvent(event);
        input.eventBus.markDone(event.id);
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        const attemptNumber = event.attemptCount + 1;

        if (error instanceof TerminalEventError) {
          settleDmIncomingTerminalFailure(event, errorMessage, "worker_terminal_error");
          input.eventBus.markDead(event.id, errorMessage);
          console.error(
            `[event-bus] dead event=${event.type} id=${event.id} reason=${errorMessage}`,
          );
          continue;
        }

        if (isTerminalDiscordError(error)) {
          settleDmIncomingTerminalFailure(event, errorMessage, "worker_discord_terminal_error");
          input.eventBus.markDead(event.id, errorMessage);
          console.error(`[event-bus] dead(discord-terminal) type=${event.type} id=${event.id}`);
          continue;
        }

        if (attemptNumber >= MAX_ATTEMPTS) {
          input.eventBus.markDead(event.id, `max attempts reached: ${errorMessage}`);
          console.error(
            `[event-bus] dead(max-attempts) type=${event.type} id=${event.id} attempts=${attemptNumber}`,
          );
          continue;
        }

        const delayMs =
          error instanceof RetryableEventError && error.delayMs
            ? error.delayMs
            : SqliteEventBus.calculateBackoffMs(attemptNumber);
        input.eventBus.markRetry(event.id, errorMessage, delayMs);
        console.warn(
          `[event-bus] retry type=${event.type} id=${event.id} attempt=${attemptNumber} delay_ms=${delayMs} reason=${errorMessage}`,
        );
      }
    }
  }

  function start(): void {
    if (running) {
      return;
    }
    running = true;
    workerPromise = runWorkerLoop().catch((error) => {
      console.error(`[event-bus] Worker loop crashed: ${toErrorMessage(error)}`);
      running = false;
    });
    reconcileTimer = setInterval(() => {
      void enqueueReconcile("timer").catch((error) => {
        console.error(`[event-bus] reconcile enqueue failed: ${toErrorMessage(error)}`);
      });
    }, RECONCILE_INTERVAL_MS);
    void enqueueReconcile("startup");
  }

  function stop(): void {
    running = false;
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    void workerPromise;
    workerPromise = null;
  }

  return {
    start,
    stop,
  };
}
