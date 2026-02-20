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
  public destroyCalls = 0;
  public autoReadyOnLogin = true;
  public ws = { ping: 50 };

  async login(_token: string): Promise<string> {
    this.loginCalls += 1;
    if (this.autoReadyOnLogin) {
      this.ready = true;
      this.emit("clientReady");
    }
    return "fake-token";
  }

  isReady(): boolean {
    return this.ready;
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.ready = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    fake.autoReadyOnLogin = false;
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token");

    await manager.start();

    const waiting = manager.waitUntilReady(100);
    setTimeout(() => {
      fake.ready = true;
      fake.emit("clientReady");
    }, 10);

    await expect(waiting).resolves.toBe(true);
    await manager.stop();
  });

  it("waitUntilReady returns false on timeout", async () => {
    const fake = new FakeClient();
    fake.autoReadyOnLogin = false;
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token");

    await manager.start();
    await expect(manager.waitUntilReady(10)).resolves.toBe(false);
    await manager.stop();
  });

  it("stop resolves pending waiters with false", async () => {
    const fake = new FakeClient();
    fake.autoReadyOnLogin = false;
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token");

    await manager.start();
    const waiting = manager.waitUntilReady(1000);
    await manager.stop();

    await expect(waiting).resolves.toBe(false);
  });

  it("heartbeat triggers forced reconnect when ready state is lost", async () => {
    const fake = new FakeClient();
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token", {
      heartbeatIntervalMs: 10,
      reconnectGraceMs: 100,
    });

    await manager.start();
    fake.ready = false;

    await sleep(1200);

    const state = manager.getState();
    expect(state.forcedReconnects).toBeGreaterThanOrEqual(1);
    expect(fake.loginCalls).toBeGreaterThanOrEqual(2);
    expect(fake.destroyCalls).toBeGreaterThanOrEqual(1);
    await manager.stop();
  });

  it("heartbeat stays idle when connection is healthy", async () => {
    const fake = new FakeClient();
    const manager = createDiscordConnectionManager(fake as unknown as Client, "token", {
      heartbeatIntervalMs: 10,
      reconnectGraceMs: 100,
    });

    await manager.start();
    const loginCallsAtStart = fake.loginCalls;

    await sleep(200);

    const state = manager.getState();
    expect(state.forcedReconnects).toBe(0);
    expect(fake.loginCalls).toBe(loginCallsAtStart);
    expect(fake.destroyCalls).toBe(0);
    await manager.stop();
  });

  it("heartbeat triggers forced reconnect on consecutive high ping", async () => {
    const fake = new FakeClient();
    fake.ws.ping = 20_000;

    const manager = createDiscordConnectionManager(fake as unknown as Client, "token", {
      heartbeatIntervalMs: 10,
      reconnectGraceMs: 100,
    });

    await manager.start();

    await sleep(1200);

    const state = manager.getState();
    expect(state.forcedReconnects).toBeGreaterThanOrEqual(1);
    expect(fake.destroyCalls).toBeGreaterThanOrEqual(1);
    await manager.stop();
  });
});
