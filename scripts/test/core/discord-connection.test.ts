import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Client } from "discord.js";
import {
  calculateReconnectDelayMs,
  createDiscordConnectionManager,
} from "../../src/core/discord-connection";

class FakeClient extends EventEmitter {
  public ready = false;
  public loginCalls = 0;
  public shouldAutoReady = true;

  async login(_token: string): Promise<string> {
    this.loginCalls += 1;
    if (this.shouldAutoReady) {
      this.ready = true;
      this.emit("clientReady");
    }
    return "fake-token";
  }

  isReady(): boolean {
    return this.ready;
  }

  destroy(): void {
    this.ready = false;
  }
}

describe("calculateReconnectDelayMs", () => {
  it("uses exponential backoff with 60s cap", () => {
    expect(calculateReconnectDelayMs(1)).toBe(1000);
    expect(calculateReconnectDelayMs(2)).toBe(2000);
    expect(calculateReconnectDelayMs(3)).toBe(4000);
    expect(calculateReconnectDelayMs(6)).toBe(32000);
    expect(calculateReconnectDelayMs(7)).toBe(60000);
    expect(calculateReconnectDelayMs(20)).toBe(60000);
  });
});

describe("createDiscordConnectionManager", () => {
  it("waitUntilReady returns true after ready event", async () => {
    const fake = new FakeClient();
    fake.shouldAutoReady = false;
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token");

    await manager.start();

    const waiting = manager.waitUntilReady(100);
    setTimeout(() => {
      fake.ready = true;
      fake.emit("clientReady");
    }, 10);

    await expect(waiting).resolves.toBe(true);
  });

  it("waitUntilReady returns false on timeout", async () => {
    const fake = new FakeClient();
    fake.shouldAutoReady = false;
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token");

    await manager.start();
    await expect(manager.waitUntilReady(10)).resolves.toBe(false);
  });

  it("stop resolves pending waiters with false", async () => {
    const fake = new FakeClient();
    fake.shouldAutoReady = false;
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token");

    await manager.start();
    const waiting = manager.waitUntilReady(1000);
    await manager.stop();

    await expect(waiting).resolves.toBe(false);
  });
});
