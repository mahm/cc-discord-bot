import type { OutboundDmRequestPayload } from "./bot-events";
import { EMPTY_RESPONSE_FALLBACK_MESSAGE } from "./message-format";

export interface OutboundDmDeliveryPolicy {
  source: "dm" | "scheduler";
  fallbackMessage?: string;
}

export function resolveOutboundDmDeliveryPolicy(
  requestSource: OutboundDmRequestPayload["source"],
): OutboundDmDeliveryPolicy {
  if (requestSource === "scheduler") {
    return {
      source: "scheduler",
    };
  }

  return {
    source: "dm",
    fallbackMessage: EMPTY_RESPONSE_FALLBACK_MESSAGE,
  };
}
