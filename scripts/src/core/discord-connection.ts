import type { Client } from "discord.js";

export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 60_000;
export const DEFAULT_WAIT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_STALE_THRESHOLD_MS = 180_000;
export const DEFAULT_RECONNECT_GRACE_MS = 20_000;
export const HIGH_PING_THRESHOLD_MS = 15_000;
export const HIGH_PING_CONSECUTIVE_LIMIT = 3;

type Logger = Pick<typeof console, "error" | "log" | "warn">;
type Timer = ReturnType<typeof setTimeout>;

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
  staleThresholdMs?: number;
  reconnectGraceMs?: number;
  logger?: Logger;
}

interface Waiter {
  resolve: (value: boolean) => void;
  timer: Timer;
}

interface UnhealthyConnection {
  reason: "not_ready" | "stale_gateway" | "high_ping";
  pingMs: number | null;
  sinceLastEventMs: number | null;
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
  const staleThresholdMs = normalizeMs(options?.staleThresholdMs, DEFAULT_STALE_THRESHOLD_MS);
  const reconnectGraceMs = normalizeMs(options?.reconnectGraceMs, DEFAULT_RECONNECT_GRACE_MS);

  let started = false;
  let stopping = false;
  let attempt = 0;
  let reconnectTimer: Timer | null = null;
  let heartbeatTimer: Timer | null = null;
  let reconnectInFlight = false;
  let forceReconnectInFlight = false;
  let heartbeatTickInFlight = false;
  let forcedReconnects = 0;
  let lastGatewayEventAt: number | null = null;
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

  function touchGatewayActivity(): void {
    lastGatewayEventAt = Date.now();
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearHeartbeatTimer(): void {
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function diagnoseConnectionHealth(now: number): UnhealthyConnection | null {
    const pingMs = getWsPingMs();
    const sinceLastEventMs = lastGatewayEventAt === null ? null : now - lastGatewayEventAt;

    if (!isReady()) {
      return { reason: "not_ready", pingMs, sinceLastEventMs };
    }

    if (sinceLastEventMs !== null && sinceLastEventMs > staleThresholdMs) {
      return { reason: "stale_gateway", pingMs, sinceLastEventMs };
    }

    if (pingMs !== null && pingMs > HIGH_PING_THRESHOLD_MS) {
      consecutiveHighPingCount += 1;
    } else {
      consecutiveHighPingCount = 0;
    }

    if (consecutiveHighPingCount >= HIGH_PING_CONSECUTIVE_LIMIT) {
      return { reason: "high_ping", pingMs, sinceLastEventMs };
    }

    return null;
  }

  async function reconnectNow(reason: string): Promise<void> {
    if (stopping || reconnectInFlight || forceReconnectInFlight || isReady()) {
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
    if (stopping || reconnectTimer || reconnectInFlight || forceReconnectInFlight || isReady()) {
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

  async function forceReconnect(reason: string): Promise<void> {
    if (stopping || forceReconnectInFlight) {
      return;
    }

    forceReconnectInFlight = true;
    forcedReconnects += 1;
    attempt += 1;
    clearReconnectTimer();
    consecutiveHighPingCount = 0;

    const delayMs = calculateReconnectDelayMs(attempt);
    logger.warn(
      `[discord-connection] event=force_reconnect_start reason=${reason} attempt=${attempt} delay_ms=${delayMs}`,
    );

    let nextRetryReason: string | null = null;
    reconnectInFlight = true;
    try {
      client.destroy();
      await wait(delayMs);
      if (stopping) {
        return;
      }

      await client.login(token);

      const ready = await waitUntilReady(reconnectGraceMs);
      if (!ready) {
        logger.warn(
          `[discord-connection] event=force_reconnect_grace_timeout reason=${reason} grace_ms=${reconnectGraceMs}`,
        );
        nextRetryReason = "force_reconnect_grace_timeout";
      } else {
        logger.log("[discord-connection] event=force_reconnect_success");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[discord-connection] event=force_reconnect_failed message=${message}`);
      nextRetryReason = "force_reconnect_failed";
    } finally {
      reconnectInFlight = false;
      forceReconnectInFlight = false;
    }

    if (nextRetryReason) {
      scheduleReconnect(nextRetryReason);
    }
  }

  async function runHeartbeatCheck(): Promise<void> {
    if (
      stopping ||
      !started ||
      heartbeatTickInFlight ||
      reconnectInFlight ||
      forceReconnectInFlight
    ) {
      return;
    }

    heartbeatTickInFlight = true;
    try {
      const now = Date.now();
      const unhealthy = diagnoseConnectionHealth(now);

      if (!unhealthy) {
        lastHealthyAt = now;
        return;
      }

      logger.warn(
        `[discord-connection] event=heartbeat_unhealthy reason=${unhealthy.reason} ready=${isReady()} ping_ms=${unhealthy.pingMs ?? "unknown"} since_last_event_ms=${unhealthy.sinceLastEventMs ?? "unknown"}`,
      );
      await forceReconnect(`heartbeat_${unhealthy.reason}`);
    } finally {
      heartbeatTickInFlight = false;
    }
  }

  function startHeartbeat(): void {
    if (heartbeatTimer || stopping) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      void runHeartbeatCheck();
    }, heartbeatIntervalMs);
    logger.log(
      `[discord-connection] event=heartbeat_started interval_ms=${heartbeatIntervalMs} stale_threshold_ms=${staleThresholdMs} reconnect_grace_ms=${reconnectGraceMs}`,
    );
  }

  function registerEvents(): void {
    client.on("clientReady", () => {
      const wasReconnecting = attempt > 0;
      attempt = 0;
      clearReconnectTimer();
      consecutiveHighPingCount = 0;
      touchGatewayActivity();
      lastHealthyAt = Date.now();
      resolveWaiters(true);

      if (wasReconnecting) {
        logger.log("[discord-connection] event=reconnect_success");
      } else {
        logger.log("[discord-connection] event=connected");
      }
    });

    client.on("raw", () => {
      touchGatewayActivity();
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
      clearReconnectTimer();
      clearHeartbeatTimer();
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
    startHeartbeat();

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
    clearReconnectTimer();
    clearHeartbeatTimer();
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
    getState,
    start,
    stop,
    waitUntilReady,
  };
}
