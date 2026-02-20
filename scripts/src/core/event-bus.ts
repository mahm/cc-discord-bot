import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BotEventLane, BotEventType } from "./bot-events";

type EventStatus = "pending" | "processing" | "retry" | "done" | "dead";

interface EventRow {
  id: string;
  type: string;
  lane: BotEventLane;
  priority: number;
  payload_json: string;
  attempt_count: number;
  status: EventStatus;
  available_at: number;
  created_at: number;
}

interface DmStateRow {
  message_id: string;
  channel_id: string;
  author_id: string;
  eye_applied: number;
  processing_done: number;
  check_applied: number;
  terminal_failed: number;
  last_error: string | null;
}

export interface EventBusEvent {
  id: string;
  type: BotEventType;
  lane: BotEventLane;
  priority: number;
  attemptCount: number;
  status: EventStatus;
  payload: unknown;
  availableAt: number;
  createdAt: number;
}

export interface PublishEventInput {
  type: BotEventType;
  lane?: BotEventLane;
  payload: unknown;
  priority?: number;
  dedupeKey?: string;
  availableAt?: number;
}

export interface DmMessageState {
  messageId: string;
  channelId: string;
  authorId: string;
  eyeApplied: boolean;
  processingDone: boolean;
  checkApplied: boolean;
  terminalFailed: boolean;
  lastError: string | null;
}

function laneRank(lane: BotEventLane): number {
  switch (lane) {
    case "interactive":
      return 0;
    case "recovery":
      return 1;
    case "scheduled":
      return 2;
    default:
      return 3;
  }
}

function snowflakeToBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export class SqliteEventBus {
  private readonly db: Database;

  constructor(private readonly dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        lane TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        locked_by TEXT,
        locked_at INTEGER,
        last_error TEXT,
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_claim
        ON events(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_processing
        ON events(status, locked_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
        ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS dm_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        eye_applied INTEGER NOT NULL DEFAULT 0,
        processing_done INTEGER NOT NULL DEFAULT 0,
        check_applied INTEGER NOT NULL DEFAULT 0,
        terminal_failed INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dm_messages_eye
        ON dm_messages(eye_applied, terminal_failed, updated_at);
      CREATE INDEX IF NOT EXISTS idx_dm_messages_check
        ON dm_messages(processing_done, check_applied, terminal_failed, updated_at);

      CREATE TABLE IF NOT EXISTS dm_offsets (
        scope TEXT PRIMARY KEY,
        last_seen_message_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  publish(input: PublishEventInput): string {
    const id = randomUUID();
    const now = Date.now();
    const lane = input.lane ?? "interactive";
    const priority = Number.isFinite(input.priority) ? Math.floor(input.priority ?? 0) : 0;
    const availableAt = input.availableAt ?? now;
    const payload = JSON.stringify(input.payload);

    try {
      this.db
        .prepare(
          `
            INSERT INTO events (
              id, type, lane, priority, payload_json, status, attempt_count,
              available_at, locked_by, locked_at, last_error, dedupe_key, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, ?)
          `,
        )
        .run(
          id,
          input.type,
          lane,
          priority,
          payload,
          availableAt,
          input.dedupeKey ?? null,
          now,
          now,
        );
      return id;
    } catch (error) {
      if (!input.dedupeKey) {
        throw error;
      }

      const existing = this.db
        .query("SELECT id FROM events WHERE dedupe_key = ? LIMIT 1")
        .get(input.dedupeKey) as { id: string } | null;
      if (existing?.id) {
        return existing.id;
      }
      throw error;
    }
  }

  claimNext(workerId: string): EventBusEvent | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const rows = this.db
        .query(
          `
            SELECT id, type, lane, priority, payload_json, attempt_count, status, available_at, created_at
            FROM events
            WHERE status IN ('pending', 'retry') AND available_at <= ?
            ORDER BY
              CASE lane
                WHEN 'interactive' THEN 0
                WHEN 'recovery' THEN 1
                WHEN 'scheduled' THEN 2
                ELSE 3
              END ASC,
              priority DESC,
              created_at ASC
            LIMIT 50
          `,
        )
        .all(now) as EventRow[];

      for (const row of rows) {
        const updated = this.db
          .query(
            `
              UPDATE events
              SET status = 'processing', locked_by = ?, locked_at = ?, updated_at = ?
              WHERE id = ? AND status IN ('pending', 'retry')
            `,
          )
          .run(workerId, now, now, row.id);

        if (Number(updated.changes ?? 0) < 1) {
          continue;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          payload = { parseError: "invalid payload_json" };
        }

        return {
          id: row.id,
          type: row.type as BotEventType,
          lane: row.lane,
          priority: row.priority,
          payload,
          attemptCount: row.attempt_count,
          status: row.status,
          availableAt: row.available_at,
          createdAt: row.created_at,
        };
      }
      return null;
    })();
  }

  markDone(eventId: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          UPDATE events
          SET status = 'done', locked_by = NULL, locked_at = NULL, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(now, eventId);
  }

  markRetry(eventId: string, errorMessage: string, delayMs: number): void {
    const now = Date.now();
    const availableAt = now + Math.max(0, delayMs);
    this.db
      .query(
        `
          UPDATE events
          SET
            status = 'retry',
            attempt_count = attempt_count + 1,
            available_at = ?,
            last_error = ?,
            locked_by = NULL,
            locked_at = NULL,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(availableAt, errorMessage.slice(0, 2000), now, eventId);
  }

  markDead(eventId: string, errorMessage: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          UPDATE events
          SET
            status = 'dead',
            attempt_count = attempt_count + 1,
            last_error = ?,
            locked_by = NULL,
            locked_at = NULL,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(errorMessage.slice(0, 2000), now, eventId);
  }

  requeueStaleProcessing(lockTimeoutMs: number): number {
    const now = Date.now();
    const staleBefore = now - Math.max(1_000, lockTimeoutMs);
    const result = this.db
      .query(
        `
          UPDATE events
          SET
            status = 'retry',
            available_at = ?,
            locked_by = NULL,
            locked_at = NULL,
            last_error = COALESCE(last_error, 'stale_processing_requeued'),
            updated_at = ?
          WHERE status = 'processing' AND locked_at IS NOT NULL AND locked_at < ?
        `,
      )
      .run(now, now, staleBefore);
    return Number(result.changes ?? 0);
  }

  upsertDmMessage(messageId: string, channelId: string, authorId: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          INSERT INTO dm_messages (
            message_id, channel_id, author_id, eye_applied, processing_done, check_applied,
            terminal_failed, last_error, created_at, updated_at
          )
          VALUES (?, ?, ?, 0, 0, 0, 0, NULL, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            author_id = excluded.author_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(messageId, channelId, authorId, now, now);
  }

  getDmMessageState(messageId: string): DmMessageState | null {
    const row = this.db
      .query(
        `
          SELECT
            message_id, channel_id, author_id, eye_applied, processing_done, check_applied,
            terminal_failed, last_error
          FROM dm_messages
          WHERE message_id = ?
          LIMIT 1
        `,
      )
      .get(messageId) as DmStateRow | null;
    if (!row) {
      return null;
    }
    return {
      messageId: row.message_id,
      channelId: row.channel_id,
      authorId: row.author_id,
      eyeApplied: row.eye_applied === 1,
      processingDone: row.processing_done === 1,
      checkApplied: row.check_applied === 1,
      terminalFailed: row.terminal_failed === 1,
      lastError: row.last_error,
    };
  }

  markEyeApplied(messageId: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          UPDATE dm_messages
          SET eye_applied = 1, updated_at = ?, last_error = NULL
          WHERE message_id = ?
        `,
      )
      .run(now, messageId);
  }

  markProcessingDone(messageId: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          UPDATE dm_messages
          SET processing_done = 1, updated_at = ?, last_error = NULL
          WHERE message_id = ?
        `,
      )
      .run(now, messageId);
  }

  markCheckApplied(messageId: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          UPDATE dm_messages
          SET check_applied = 1, updated_at = ?, last_error = NULL
          WHERE message_id = ?
        `,
      )
      .run(now, messageId);
  }

  markDmTerminalFailure(messageId: string, errorMessage: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          UPDATE dm_messages
          SET terminal_failed = 1, updated_at = ?, last_error = ?
          WHERE message_id = ?
        `,
      )
      .run(now, errorMessage.slice(0, 2000), messageId);
  }

  setDmLastError(messageId: string, errorMessage: string): void {
    const now = Date.now();
    this.db
      .query(
        `
          UPDATE dm_messages
          SET updated_at = ?, last_error = ?
          WHERE message_id = ?
        `,
      )
      .run(now, errorMessage.slice(0, 2000), messageId);
  }

  listDmMissingEye(
    limit: number,
  ): Array<Pick<DmMessageState, "messageId" | "channelId" | "authorId">> {
    return (
      this.db
        .query(
          `
            SELECT message_id, channel_id, author_id
            FROM dm_messages
            WHERE eye_applied = 0 AND terminal_failed = 0
            ORDER BY updated_at ASC
            LIMIT ?
          `,
        )
        .all(Math.max(1, limit)) as Array<{
        message_id: string;
        channel_id: string;
        author_id: string;
      }>
    ).map((row) => ({
      messageId: row.message_id,
      channelId: row.channel_id,
      authorId: row.author_id,
    }));
  }

  listDmMissingCheck(
    limit: number,
  ): Array<Pick<DmMessageState, "messageId" | "channelId" | "authorId">> {
    return (
      this.db
        .query(
          `
            SELECT message_id, channel_id, author_id
            FROM dm_messages
            WHERE processing_done = 1 AND check_applied = 0 AND terminal_failed = 0
            ORDER BY updated_at ASC
            LIMIT ?
          `,
        )
        .all(Math.max(1, limit)) as Array<{
        message_id: string;
        channel_id: string;
        author_id: string;
      }>
    ).map((row) => ({
      messageId: row.message_id,
      channelId: row.channel_id,
      authorId: row.author_id,
    }));
  }

  getDmOffset(scope: string): string | null {
    const row = this.db
      .query(
        `
          SELECT last_seen_message_id
          FROM dm_offsets
          WHERE scope = ?
          LIMIT 1
        `,
      )
      .get(scope) as { last_seen_message_id: string } | null;
    return row?.last_seen_message_id ?? null;
  }

  hasActiveDmIncomingEvent(messageId: string): boolean {
    const row = this.db
      .query(
        `
          SELECT 1
          FROM events
          WHERE type = 'dm.incoming'
            AND status IN ('pending', 'processing', 'retry')
            AND json_extract(payload_json, '$.messageId') = ?
          LIMIT 1
        `,
      )
      .get(messageId) as { 1: number } | null;
    return row !== null;
  }

  updateDmOffset(scope: string, messageId: string): void {
    const current = this.getDmOffset(scope);
    if (current) {
      const currentValue = snowflakeToBigInt(current);
      const nextValue = snowflakeToBigInt(messageId);
      if (currentValue !== null && nextValue !== null && nextValue <= currentValue) {
        return;
      }
    }

    const now = Date.now();
    this.db
      .query(
        `
          INSERT INTO dm_offsets (scope, last_seen_message_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET
            last_seen_message_id = excluded.last_seen_message_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(scope, messageId, now);
  }

  getQueueCounts(): Record<EventStatus, number> {
    const rows = this.db
      .query("SELECT status, COUNT(*) as count FROM events GROUP BY status")
      .all() as Array<{ status: EventStatus; count: number }>;
    const counts: Record<EventStatus, number> = {
      pending: 0,
      processing: 0,
      retry: 0,
      done: 0,
      dead: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  static calculateBackoffMs(attempt: number): number {
    if (attempt <= 1) {
      return 1_000;
    }
    const cappedAttempt = Math.min(attempt, 10);
    return Math.min(1_000 * 2 ** (cappedAttempt - 1), 60_000);
  }

  static compareLane(left: BotEventLane, right: BotEventLane): number {
    return laneRank(left) - laneRank(right);
  }
}
