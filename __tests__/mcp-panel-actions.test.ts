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
    expect(output).toContain("Keep connected after reload");
    panel.dispose();
  });

  it("shows not-connected state as connectable instead of blocked auth rows", () => {
    const cfg: McpConfig = { mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } } };
    const cbs = callbacks();
    cbs.canAuthenticate = () => false;
    cbs.getConnectionStatus = () => "idle";
    const panel = createMcpPanel(cfg, cache({ mcpServers: { github: cfg.mcpServers.context7 } }), new Map(), cbs, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("Connection status: not connected");
    expect(output).toContain("Connect for this session / refresh tools");
    expect(output).not.toContain("Authenticate");
    expect(output).not.toContain("Re-authenticate");
    panel.dispose();
  });

  it("renders multiline tool descriptions as one overlay row", () => {
    const cfg = config();
    const cached = cache(cfg);
    cached.servers.github.tools = [{ name: "API-get-user", description: "Notion | Retrieve a user\nError Responses:\n400: 400" }];
    const panel = createMcpPanel(cfg, cached, new Map(), callbacks(), { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    down(panel, 7);

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("Notion | Retrieve a user Error Responses: 400: 400");
    expect(output).not.toContain("Retrieve a user\nError Responses");
    panel.dispose();
  });

  it("saves lifecycle changes for reload persistence", () => {
    const cfg: McpConfig = { mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } } };
    const cbs = callbacks();
    cbs.canAuthenticate = () => false;
    cbs.getConnectionStatus = () => "idle";
    const done = vi.fn();
    const panel = createMcpPanel(cfg, cache({ mcpServers: { github: cfg.mcpServers.context7 } }), new Map(), cbs, { requestRender: () => {} }, done);

    panel.handleInput("\r");
    down(panel, 4);
    panel.handleInput("\r");
    panel.handleInput("\x13");

    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      cancelled: false,
      lifecycleChanges: new Map([["context7", "keep-alive"]]),
    }));
    panel.dispose();
  });

  it("keeps stdio env-token servers usable without OAuth actions", () => {
    const cfg: McpConfig = { mcpServers: { notionApi: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "test" } } } };
    const cbs = callbacks();
    cbs.canAuthenticate = () => false;
    cbs.getConnectionStatus = () => "idle";
    const panel = createMcpPanel(cfg, cache({ mcpServers: { github: cfg.mcpServers.notionApi } }), new Map(), cbs, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("notionApi");
    expect(output).toContain("Connect for this session / refresh tools");
    expect(output).not.toContain("Authenticate");
    expect(output).not.toContain("MCP panel error");
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
    down(panel, 8);
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
    panel.handleInput("\x1b[200~https://demo.example/mcp\x1b[201~");
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

  it("keeps the overlay usable when connect/refresh fails", async () => {
    const cfg = config();
    const cbs = callbacks();
    cbs.reconnect = vi.fn(() => { throw new Error("connect failed"); });
    const panel = createMcpPanel(cfg, cache(cfg), new Map(), cbs, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    down(panel, 4);
    panel.handleInput("\r");
    await Promise.resolve();

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("github: connect failed");
    expect(output).not.toContain("MCP panel error");
    panel.dispose();
  });

  it("stores env variables from the add form for stdio servers", async () => {
    const cfg = config();
    const cbs = callbacks();
    cbs.addServer = vi.fn(async () => {});
    const panel = createMcpPanel(cfg, cache(cfg), new Map(), cbs, { requestRender: () => {} }, () => {});

    panel.handleInput("a");
    for (const ch of "notionApiResearch") panel.handleInput(ch);
    panel.handleInput("\r"); // transport
    panel.handleInput("\x1b[C"); // stdio
    panel.handleInput("\r"); // target
    for (const ch of "npx -y @notionhq/notion-mcp-server") panel.handleInput(ch);
    panel.handleInput("\r"); // auth
    panel.handleInput("\r"); // env
    panel.handleInput("\x1b[200~NOTION_TOKEN=ntn_test_token\x1b[201~");
    panel.handleInput("\r"); // scope
    panel.handleInput("\r"); // lifecycle
    panel.handleInput("\r"); // submit
    await Promise.resolve();

    expect(cbs.addServer).toHaveBeenCalledWith(
      "notionApiResearch",
      expect.objectContaining({
        command: "npx",
        args: ["-y", "@notionhq/notion-mcp-server"],
        env: { NOTION_TOKEN: "ntn_test_token" },
        lifecycle: "lazy",
      }),
      "user",
    );
    panel.dispose();
  });
});
