import type { Client } from "discord.js";

export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 60_000;
export const DEFAULT_WAIT_READY_TIMEOUT_MS = 10_000;

type Logger = Pick<typeof console, "error" | "log" | "warn">;
type Timer = ReturnType<typeof setTimeout>;

export interface DiscordConnectionManager {
  isReady(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitUntilReady(timeoutMs?: number): Promise<boolean>;
}

export interface DiscordConnectionOptions {
  logger?: Logger;
}

interface Waiter {
  resolve: (value: boolean) => void;
  timer: Timer;
}

export function calculateReconnectDelayMs(attempt: number): number {
  if (attempt <= 1) {
    return INITIAL_RECONNECT_DELAY_MS;
  }
  return Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
}

export function createDiscordConnectionManager(
  client: Client,
  token: string,
  options?: DiscordConnectionOptions,
): DiscordConnectionManager {
  const logger = options?.logger ?? console;

  let started = false;
  let stopping = false;
  let attempt = 0;
  let reconnectTimer: Timer | null = null;
  let reconnectInFlight = false;
  const waiters = new Set<Waiter>();

  function resolveWaiters(value: boolean): void {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
    waiters.clear();
  }

  function isReady(): boolean {
    return client.isReady();
  }

  async function reconnectNow(reason: string): Promise<void> {
    if (stopping || reconnectInFlight || isReady()) {
      return;
    }
    reconnectInFlight = true;

    logger.warn(
      `[discord-connection] event=reconnect_attempt reason=${reason} attempt=${attempt || 1}`,
    );

    try {
      await client.login(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=reconnect_failed message=${message}`);
      scheduleReconnect("login_failed");
    } finally {
      reconnectInFlight = false;
    }
  }

  function scheduleReconnect(reason: string): void {
    if (stopping || reconnectTimer || reconnectInFlight || isReady()) {
      return;
    }

    attempt += 1;
    const delayMs = calculateReconnectDelayMs(attempt);
    logger.warn(
      `[discord-connection] event=reconnect_scheduled reason=${reason} attempt=${attempt} delay_ms=${delayMs}`,
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnectNow(reason);
    }, delayMs);
  }

  function registerEvents(): void {
    client.on("clientReady", () => {
      const wasReconnecting = attempt > 0;
      attempt = 0;
      resolveWaiters(true);

      if (wasReconnecting) {
        logger.log("[discord-connection] event=reconnect_success");
      } else {
        logger.log("[discord-connection] event=connected");
      }
    });

    client.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=client_error message=${message}`);
      if (!isReady()) {
        scheduleReconnect("client_error");
      }
    });

    client.on("shardError", (error, shardId) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=shard_error shard=${shardId} message=${message}`);
      if (!isReady()) {
        scheduleReconnect("shard_error");
      }
    });

    client.on("shardDisconnect", (event, shardId) => {
      logger.warn(
        `[discord-connection] event=disconnect shard=${shardId} code=${event.code} reason=${event.reason ?? "unknown"} clean=${event.wasClean}`,
      );
      scheduleReconnect("shard_disconnect");
    });

    client.on("shardReconnecting", (shardId) => {
      logger.warn(`[discord-connection] event=shard_reconnecting shard=${shardId}`);
    });

    client.on("invalidated", () => {
      logger.error("[discord-connection] event=invalidated action=stop");
      stopping = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      resolveWaiters(false);
    });
  }

  async function start(): Promise<void> {
    if (started) {
      return;
    }
    started = true;
    stopping = false;

    registerEvents();

    try {
      await client.login(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=initial_login_failed message=${message}`);
      scheduleReconnect("initial_login_failed");
    }
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    resolveWaiters(false);
    client.destroy();
  }

  async function waitUntilReady(timeoutMs = DEFAULT_WAIT_READY_TIMEOUT_MS): Promise<boolean> {
    if (isReady()) {
      return true;
    }
    if (stopping) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);

      const waiter: Waiter = {
        resolve: (value) => {
          resolve(value);
        },
        timer,
      };
      waiters.add(waiter);
    });
  }

  return {
    isReady,
    start,
    stop,
    waitUntilReady,
  };
}
