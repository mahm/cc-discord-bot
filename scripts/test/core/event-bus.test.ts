import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BotEventLane } from "../../src/core/bot-events";
import {
  BOT_EVENT_DM_RECONCILE_RUN,
  BOT_EVENT_DM_RECOVER_RUN,
  BOT_EVENT_OUTBOUND_DM_REQUEST,
  BOT_EVENT_SCHEDULER_TRIGGERED,
} from "../../src/core/bot-events";
import { SqliteEventBus } from "../../src/core/event-bus";

let tempDir: string;
let eventBus: SqliteEventBus;

describe("event-bus claimNext", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-discord-bot-event-bus-"));
    eventBus = new SqliteEventBus(path.join(tempDir, "event-bus.sqlite3"));
  });

  afterEach(async () => {
    eventBus.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("claims only specified lanes when lane filters are provided", () => {
    eventBus.publish({
      type: BOT_EVENT_SCHEDULER_TRIGGERED,
      lane: "scheduled",
      payload: { scheduleName: "main", triggeredAt: Date.now() },
    });
    eventBus.publish({
      type: BOT_EVENT_SCHEDULER_TRIGGERED,
      lane: "scheduled_isolated",
      payload: { scheduleName: "isolated", triggeredAt: Date.now() },
    });

    const claimed = eventBus.claimNext("worker-isolated", { lanes: ["scheduled_isolated"] });
    expect(claimed).not.toBeNull();
    expect(claimed?.lane).toBe("scheduled_isolated");
  });

  it("keeps default lane priority ordering without lane filters", () => {
    eventBus.publish({
      type: BOT_EVENT_DM_RECONCILE_RUN,
      lane: "system",
      payload: { reason: "system", triggeredAt: Date.now() },
    });
    eventBus.publish({
      type: BOT_EVENT_SCHEDULER_TRIGGERED,
      lane: "scheduled_isolated",
      payload: { scheduleName: "iso", triggeredAt: Date.now() },
    });
    eventBus.publish({
      type: BOT_EVENT_SCHEDULER_TRIGGERED,
      lane: "scheduled",
      payload: { scheduleName: "main", triggeredAt: Date.now() },
    });
    eventBus.publish({
      type: BOT_EVENT_DM_RECOVER_RUN,
      lane: "recovery",
      payload: { reason: "recover", triggeredAt: Date.now() },
    });
    eventBus.publish({
      type: BOT_EVENT_OUTBOUND_DM_REQUEST,
      lane: "interactive",
      payload: { requestId: "req", source: "manual_send", text: "hello", userId: "1" },
    });

    const claimedLanes: BotEventLane[] = [];
    for (let index = 0; index < 5; index += 1) {
      const event = eventBus.claimNext("worker-default");
      expect(event).not.toBeNull();
      if (!event) {
        continue;
      }
      claimedLanes.push(event.lane);
      eventBus.markDone(event.id);
    }

    expect(claimedLanes).toEqual([
      "interactive",
      "recovery",
      "scheduled",
      "scheduled_isolated",
      "system",
    ]);
  });
});
