import { describe, expect, it } from "bun:test";
import { EMPTY_RESPONSE_FALLBACK_MESSAGE } from "../../src/core/message-format";
import { resolveOutboundDmDeliveryPolicy } from "../../src/core/outbound-dm-policy";

describe("resolveOutboundDmDeliveryPolicy", () => {
  it("does not set fallback message for scheduler source", () => {
    const policy = resolveOutboundDmDeliveryPolicy("scheduler");
    expect(policy).toEqual({
      source: "scheduler",
    });
  });

  it("keeps fallback message for non-scheduler sources", () => {
    expect(resolveOutboundDmDeliveryPolicy("dm_reply")).toEqual({
      source: "dm",
      fallbackMessage: EMPTY_RESPONSE_FALLBACK_MESSAGE,
    });
    expect(resolveOutboundDmDeliveryPolicy("manual_send")).toEqual({
      source: "dm",
      fallbackMessage: EMPTY_RESPONSE_FALLBACK_MESSAGE,
    });
    expect(resolveOutboundDmDeliveryPolicy("auth_error")).toEqual({
      source: "dm",
      fallbackMessage: EMPTY_RESPONSE_FALLBACK_MESSAGE,
    });
  });
});
