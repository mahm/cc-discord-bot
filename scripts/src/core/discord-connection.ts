import type { Client } from "discord.js";

export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 60_000;
export const MAX_RECONNECT_ATTEMPT = 10;
export const DEFAULT_WAIT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_RECONNECT_GRACE_MS = 20_000;
export const HIGH_PING_THRESHOLD_MS = 15_000;
export const HIGH_PING_CONSECUTIVE_LIMIT = 3;

type Logger = Pick<typeof console, "error" | "log" | "warn">;
type WaitTimer = ReturnType<typeof setTimeout>;
type HeartbeatTimer = ReturnType<typeof setInterval>;

interface PingCapableClient {
  ws?: {
    ping?: number;
  };
}

export interface DiscordConnectionManager {
  isReady(): boolean;
  getState(): DiscordConnectionState;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitUntilReady(timeoutMs?: number): Promise<boolean>;
}

export interface DiscordConnectionState {
  ready: boolean;
  lastHealthyAt: number | null;
  reconnectAttempt: number;
  forcedReconnects: number;
}

export interface DiscordConnectionOptions {
  heartbeatIntervalMs?: number;
  reconnectGraceMs?: number;
  logger?: Logger;
}

interface Waiter {
  resolve: (value: boolean) => void;
  timer: WaitTimer;
}

interface UnhealthyConnection {
  reason: "not_ready" | "high_ping";
  pingMs: number | null;
}

function normalizeMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }
  return Math.floor(value);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  const heartbeatIntervalMs = normalizeMs(
    options?.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const reconnectGraceMs = normalizeMs(options?.reconnectGraceMs, DEFAULT_RECONNECT_GRACE_MS);

  let started = false;
  let stopping = false;
  let attempt = 0;
  let heartbeatTimer: HeartbeatTimer | null = null;
  let reconnectPromise: Promise<void> | null = null;
  let reconnectReason: string | null = null;
  let forceReconnectRequested = false;
  let forcedReconnects = 0;
  let lastHealthyAt: number | null = null;
  let consecutiveHighPingCount = 0;
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

  function getState(): DiscordConnectionState {
    return {
      ready: isReady(),
      lastHealthyAt,
      reconnectAttempt: attempt,
      forcedReconnects,
    };
  }

  function getWsPingMs(): number | null {
    const ping = (client as unknown as PingCapableClient).ws?.ping;
    if (typeof ping !== "number" || !Number.isFinite(ping)) {
      return null;
    }
    return ping;
  }

  function clearHeartbeatTimer(): void {
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function diagnoseConnectionHealth(): UnhealthyConnection | null {
    const pingMs = getWsPingMs();

    if (!isReady()) {
      return { reason: "not_ready", pingMs };
    }

    if (pingMs !== null && pingMs > HIGH_PING_THRESHOLD_MS) {
      consecutiveHighPingCount += 1;
    } else {
      consecutiveHighPingCount = 0;
    }

    if (consecutiveHighPingCount >= HIGH_PING_CONSECUTIVE_LIMIT) {
      return { reason: "high_ping", pingMs };
    }

    return null;
  }

  function requestReconnect(reason: string, force = false): void {
    if (stopping) {
      return;
    }
    reconnectReason = reason;
    if (force) {
      forceReconnectRequested = true;
    }

    if (reconnectPromise) {
      return;
    }

    reconnectPromise = runReconnectLoop().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=reconnect_loop_failed message=${message}`);
    });
  }

  async function runReconnectLoop(): Promise<void> {
    try {
      while (!stopping && (forceReconnectRequested || !isReady())) {
        attempt = Math.min(attempt + 1, MAX_RECONNECT_ATTEMPT);
        const reason = reconnectReason ?? "retry";
        const forceCurrentCycle = forceReconnectRequested;
        reconnectReason = null;
        forceReconnectRequested = false;
        if (forceCurrentCycle) {
          forcedReconnects += 1;
        }
        consecutiveHighPingCount = 0;

        const delayMs = attempt <= 1 ? 0 : calculateReconnectDelayMs(attempt);
        logger.warn(
          `[discord-connection] event=reconnect_scheduled reason=${reason} attempt=${attempt} delay_ms=${delayMs}`,
        );
        if (delayMs > 0) {
          await wait(delayMs);
        }
        if (stopping || (!forceCurrentCycle && isReady())) {
          return;
        }

        logger.warn(
          `[discord-connection] event=reconnect_attempt reason=${reason} attempt=${attempt}`,
        );

        client.destroy();
        try {
          await client.login(token);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[discord-connection] event=reconnect_failed message=${message}`);
          continue;
        }

        const ready = await waitUntilReady(reconnectGraceMs);
        if (!ready) {
          logger.warn(
            `[discord-connection] event=reconnect_grace_timeout reason=${reason} grace_ms=${reconnectGraceMs}`,
          );
        }
      }
    } finally {
      reconnectPromise = null;
      if (!stopping && !isReady() && reconnectReason) {
        requestReconnect(reconnectReason, forceReconnectRequested);
      }
    }
  }

  function runHeartbeatCheck(): void {
    if (stopping || !started || reconnectPromise) {
      return;
    }

    const unhealthy = diagnoseConnectionHealth();
    if (!unhealthy) {
      lastHealthyAt = Date.now();
      return;
    }

    logger.warn(
      `[discord-connection] event=heartbeat_unhealthy reason=${unhealthy.reason} ready=${isReady()} ping_ms=${unhealthy.pingMs ?? "unknown"}`,
    );
    requestReconnect(`heartbeat_${unhealthy.reason}`, true);
  }

  function startHeartbeat(): void {
    if (heartbeatTimer || stopping) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      runHeartbeatCheck();
    }, heartbeatIntervalMs);
    logger.log(
      `[discord-connection] event=heartbeat_started interval_ms=${heartbeatIntervalMs} reconnect_grace_ms=${reconnectGraceMs}`,
    );
  }

  function registerEvents(): void {
    client.on("clientReady", () => {
      const isFirstConnection = lastHealthyAt === null;
      attempt = 0;
      reconnectReason = null;
      forceReconnectRequested = false;
      consecutiveHighPingCount = 0;
      lastHealthyAt = Date.now();
      resolveWaiters(true);

      if (isFirstConnection) {
        logger.log("[discord-connection] event=connected");
      } else {
        logger.log("[discord-connection] event=reconnect_success");
      }
    });

    client.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=client_error message=${message}`);
      if (!isReady()) {
        requestReconnect("client_error");
      }
    });

    client.on("shardError", (error, shardId) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=shard_error shard=${shardId} message=${message}`);
      if (!isReady()) {
        requestReconnect("shard_error");
      }
    });

    client.on("shardDisconnect", (event, shardId) => {
      logger.warn(
        `[discord-connection] event=disconnect shard=${shardId} code=${event.code} reason=${event.reason ?? "unknown"} clean=${event.wasClean}`,
      );
      requestReconnect("shard_disconnect");
    });

    client.on("shardReconnecting", (shardId) => {
      logger.warn(`[discord-connection] event=shard_reconnecting shard=${shardId}`);
    });

    client.on("invalidated", () => {
      logger.error("[discord-connection] event=invalidated action=stop");
      stopping = true;
      clearHeartbeatTimer();
      reconnectReason = null;
      forceReconnectRequested = false;
      resolveWaiters(false);
      client.destroy();
    });
  }

  async function start(): Promise<void> {
    if (started) {
      return;
    }
    started = true;
    stopping = false;

    registerEvents();
    startHeartbeat();

    try {
      await client.login(token);
      void waitUntilReady(reconnectGraceMs).then((ready) => {
        if (ready || stopping) {
          return;
        }
        logger.warn(
          `[discord-connection] event=initial_login_grace_timeout grace_ms=${reconnectGraceMs}`,
        );
        requestReconnect("initial_login_grace_timeout");
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=initial_login_failed message=${message}`);
      requestReconnect("initial_login_failed");
    }
  }

  async function stop(): Promise<void> {
    stopping = true;
    clearHeartbeatTimer();
    reconnectReason = null;
    forceReconnectRequested = false;
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
      const timer = setTimeout(
        () => {
          waiters.delete(waiter);
          resolve(false);
        },
        Math.max(1, timeoutMs),
      );

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
    getState,
    start,
    stop,
    waitUntilReady,
  };
}
