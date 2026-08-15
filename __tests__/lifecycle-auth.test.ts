import { afterEach, describe, expect, it, vi } from "vitest";
import { McpLifecycleManager } from "../lifecycle.ts";

describe("McpLifecycleManager OAuth health checks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not retry a keep-alive server waiting for authentication", async () => {
    vi.useFakeTimers();
    const manager = {
      getConnection: vi.fn(() => ({ status: "needs-auth" })),
      connect: vi.fn(),
      isIdle: vi.fn(() => false),
      close: vi.fn(),
      closeAll: vi.fn(),
    };
    const lifecycle = new McpLifecycleManager(manager as never);
    lifecycle.markKeepAlive("oauth", { url: "https://example.test/mcp", auth: "oauth" });
    lifecycle.startHealthChecks(10);

    await vi.advanceTimersByTimeAsync(10);

    expect(manager.connect).not.toHaveBeenCalled();
    await lifecycle.gracefulShutdown();
  });

  it("does not announce a reconnect when the server resolves to needs-auth", async () => {
    vi.useFakeTimers();
    const manager = {
      getConnection: vi.fn(() => undefined),
      connect: vi.fn(async () => ({ status: "needs-auth" })),
      isIdle: vi.fn(() => false),
      close: vi.fn(),
      closeAll: vi.fn(),
    };
    const onReconnect = vi.fn();
    const lifecycle = new McpLifecycleManager(manager as never);
    lifecycle.markKeepAlive("oauth", { url: "https://example.test/mcp", auth: "oauth" });
    lifecycle.setReconnectCallback(onReconnect);
    lifecycle.startHealthChecks(10);

    await vi.advanceTimersByTimeAsync(10);

    expect(manager.connect).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalled();
    await lifecycle.gracefulShutdown();
  });
});
