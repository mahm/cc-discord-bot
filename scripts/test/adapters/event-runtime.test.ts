import { describe, expect, it } from "bun:test";
import { buildEventWorkerSpecs } from "../../src/adapters/event-runtime";
import { SCHEDULED_ISOLATED_WORKER_COUNT } from "../../src/core/runtime-settings";

describe("buildEventWorkerSpecs", () => {
  it("creates one main worker and dedicated isolated workers", () => {
    const specs = buildEventWorkerSpecs(99999);

    expect(specs.length).toBe(1 + SCHEDULED_ISOLATED_WORKER_COUNT);
    expect(specs[0]).toEqual({
      workerId: "runtime-main-99999",
      lanes: ["interactive", "recovery", "scheduled", "system"],
      allowStaleRequeue: true,
    });

    for (let index = 1; index < specs.length; index += 1) {
      expect(specs[index]).toEqual({
        workerId: `runtime-isolated-99999-${index}`,
        lanes: ["scheduled_isolated"],
        allowStaleRequeue: false,
      });
    }
  });
});
