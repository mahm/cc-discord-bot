/**
 * Purpose: Event type key for incoming direct messages to be processed.
 * Unit: string identifier.
 * Impact: Renaming requires synchronized updates across publishers/consumers and stored events.
 */
export const BOT_EVENT_DM_INCOMING = "dm.incoming";
/**
 * Purpose: Event type key for outbound DM delivery requests.
 * Unit: string identifier.
 * Impact: Renaming requires synchronized updates across publishers/consumers and stored events.
 */
export const BOT_EVENT_OUTBOUND_DM_REQUEST = "outbound.dm.request";
/**
 * Purpose: Event type key for scheduler trigger notifications.
 * Unit: string identifier.
 * Impact: Renaming requires synchronized updates across publishers/consumers and stored events.
 */
export const BOT_EVENT_SCHEDULER_TRIGGERED = "scheduler.triggered";
/**
 * Purpose: Event type key for recovery scan runs.
 * Unit: string identifier.
 * Impact: Renaming requires synchronized updates across publishers/consumers and stored events.
 */
export const BOT_EVENT_DM_RECOVER_RUN = "dm.recover.run";
/**
 * Purpose: Event type key for periodic reconcile runs.
 * Unit: string identifier.
 * Impact: Renaming requires synchronized updates across publishers/consumers and stored events.
 */
export const BOT_EVENT_DM_RECONCILE_RUN = "dm.reconcile.run";
/**
 * Purpose: Time-to-live for scheduler trigger events.
 * Unit: milliseconds.
 * Impact: Lower values reduce stale execution risk but may drop delayed jobs.
 */
export const SCHEDULER_EVENT_TTL_MS = 15 * 60 * 1000;

export type BotEventType =
  | typeof BOT_EVENT_DM_INCOMING
  | typeof BOT_EVENT_OUTBOUND_DM_REQUEST
  | typeof BOT_EVENT_SCHEDULER_TRIGGERED
  | typeof BOT_EVENT_DM_RECOVER_RUN
  | typeof BOT_EVENT_DM_RECONCILE_RUN;

export type BotEventLane =
  | "interactive"
  | "scheduled"
  | "scheduled_isolated"
  | "recovery"
  | "system";

export interface DmIncomingEventPayload {
  messageId: string;
  channelId: string;
  authorId: string;
  messageText?: string;
}

export interface OutboundDmAttachmentPayload {
  path: string;
  name: string;
}

export interface OutboundDmRequestPayload {
  requestId: string;
  source: "dm_reply" | "scheduler" | "manual_send" | "auth_error";
  text: string;
  userId?: string;
  channelId?: string;
  files?: OutboundDmAttachmentPayload[];
  context?: string;
}

export interface SchedulerTriggeredEventPayload {
  scheduleName: string;
  triggeredAt: number;
  expiresAt?: number;
}

export interface DmRecoverRunEventPayload {
  reason: string;
  triggeredAt: number;
}

export interface DmReconcileRunEventPayload {
  reason: string;
  triggeredAt: number;
}
