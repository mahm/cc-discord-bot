import { describe, expect, it } from "bun:test";
import { runWithEmptyResponseRetry } from "../../src/core/claude-retry";

describe("runWithEmptyResponseRetry", () => {
  it("returns immediately when first response is non-empty", async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };

    const result = await runWithEmptyResponseRetry(
      async () => ({
        response: "ok",
      }),
      {
        source: "dm",
      },
      sleep,
    );

    expect(result.attempts).toBe(1);
    expect(result.result.response).toBe("ok");
    expect(sleepCalls).toEqual([]);
  });

  it("retries empty responses and succeeds when non-empty appears", async () => {
    let callCount = 0;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };

    const result = await runWithEmptyResponseRetry(
      async () => {
        callCount += 1;
        if (callCount < 3) {
          return { response: "   " };
        }
        return { response: "final response" };
      },
      {
        source: "scheduler",
        maxRetries: 3,
        delayMs: 10,
      },
      sleep,
    );

    expect(result.attempts).toBe(3);
    expect(result.result.response).toBe("final response");
    expect(sleepCalls).toEqual([10, 10]);
  });

  it("returns last empty response after max retries", async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };

    const result = await runWithEmptyResponseRetry(
      async () => ({
        response: "",
      }),
      {
        source: "unknown",
        maxRetries: 3,
        delayMs: 5,
      },
      sleep,
    );

    expect(result.attempts).toBe(4);
    expect(result.result.response).toBe("");
    expect(sleepCalls).toEqual([5, 5, 5]);
  });

  it("does not retry on runner errors", async () => {
    let callCount = 0;
    const sleep = async (_ms: number): Promise<void> => {};

    await expect(
      runWithEmptyResponseRetry(
        async () => {
          callCount += 1;
          throw new Error("runner failed");
        },
        {
          source: "dm",
          maxRetries: 3,
          delayMs: 1,
        },
        sleep,
      ),
    ).rejects.toThrow("runner failed");

    expect(callCount).toBe(1);
  });
});
