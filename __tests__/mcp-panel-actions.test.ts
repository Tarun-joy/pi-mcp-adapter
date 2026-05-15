import { describe, expect, it, vi } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks, ServerProvenance } from "../types.ts";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function config(): McpConfig {
  return { mcpServers: { github: { url: "https://example.com/mcp", auth: "oauth" } } };
}

function cache(cfg: McpConfig): MetadataCache {
  return {
    version: 1,
    servers: {
      github: {
        configHash: computeServerHash(cfg.mcpServers.github),
        cachedAt: Date.now(),
        tools: [{ name: "search", description: "Search repositories" }],
        resources: [],
      },
    },
  };
}

function callbacks(): McpPanelCallbacks {
  return {
    reconnect: vi.fn(async () => true),
    canAuthenticate: () => true,
    authenticate: vi.fn(async () => ({ ok: true })),
    reauthenticate: vi.fn(async () => ({ ok: true })),
    clearServerCache: vi.fn(async () => true),
    getConnectionStatus: () => "connected",
    refreshCacheAfterReconnect: () => null,
  };
}

function down(panel: { handleInput(data: string): void }, count: number) {
  for (let i = 0; i < count; i++) panel.handleInput("\x1b[B");
}

describe("mcp-panel server actions", () => {
  it("shows server actions after expanding a server", () => {
    const cfg = config();
    const panel = createMcpPanel(cfg, cache(cfg), new Map(), callbacks(), { requestRender: () => {} }, () => {});

    panel.handleInput("\r");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("Authenticate");
    expect(output).toContain("Re-authenticate");
    expect(output).toContain("Reconnect / refresh tools");
    expect(output).toContain("Clear cached tools");
    panel.dispose();
  });

  it("shows configured scope and config path for each server", () => {
    const cfg = config();
    const provenance = new Map<string, ServerProvenance>([
      ["github", { kind: "project", path: "/repo/.mcp.json" }],
    ]);
    const panel = createMcpPanel(cfg, cache(cfg), provenance, callbacks(), { requestRender: () => {} }, () => {});

    expect(stripAnsi(panel.render(100).join("\n"))).toContain("github (project, 1 tools)");

    panel.handleInput("\r");
    expect(stripAnsi(panel.render(140).join("\n"))).toContain("github (project, 1 tools · /repo/.mcp.json)");
    panel.dispose();
  });

  it("clears a server cache from the action row", async () => {
    const cfg = config();
    const cbs = callbacks();
    const panel = createMcpPanel(cfg, cache(cfg), new Map(), cbs, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    down(panel, 5);
    panel.handleInput("\r");
    await Promise.resolve();

    expect(cbs.clearServerCache).toHaveBeenCalledWith("github");
    panel.dispose();
  });

  it("keeps tool-row Enter non-destructive", () => {
    const cfg = config();
    const done = vi.fn();
    const panel = createMcpPanel(cfg, cache(cfg), new Map(), callbacks(), { requestRender: () => {} }, done);

    panel.handleInput("\r");
    down(panel, 7);
    panel.handleInput("\r");

    expect(done).not.toHaveBeenCalled();
    expect(stripAnsi(panel.render(100).join("\n"))).toContain("Space toggles direct");
    panel.dispose();
  });

  it("adds a server from the add form", async () => {
    const cfg = config();
    const cbs = callbacks();
    cbs.addServer = vi.fn(async () => {});
    const done = vi.fn();
    const panel = createMcpPanel(cfg, cache(cfg), new Map(), cbs, { requestRender: () => {} }, done);

    panel.handleInput("a");
    for (const ch of "demo") panel.handleInput(ch);
    panel.handleInput("\r"); // transport
    panel.handleInput("\r"); // target
    for (const ch of "https://demo.example/mcp") panel.handleInput(ch);
    panel.handleInput("\r"); // auth
    panel.handleInput("\r"); // env
    panel.handleInput("\r"); // scope
    panel.handleInput("\r"); // lifecycle
    panel.handleInput("\r"); // submit
    await Promise.resolve();

    expect(cbs.addServer).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({ url: "https://demo.example/mcp", lifecycle: "lazy" }),
      "user",
    );
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: false, addedServer: "demo" }));
    panel.dispose();
  });
});
