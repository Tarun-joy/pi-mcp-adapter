import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { isToolExcluded } from "./types.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerEntry, ServerProvenance } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import type { MetadataCache, ServerCacheEntry, CachedTool } from "./metadata-cache.ts";

type Status = "connected" | "idle" | "failed" | "needs-auth" | "connecting";
type Item = { type: "add" } | { type: "server"; s: number } | { type: "action"; s: number; action: Action } | { type: "tool"; s: number; t: number };
type Action = "status" | "authenticate" | "reauthenticate" | "refresh" | "clear-cache" | "tools";
type Field = "name" | "transport" | "target" | "auth" | "scope" | "lifecycle" | "env";
type PanelOptions = { noticeLines?: string[]; authOnly?: boolean; selectedText?: (text: string) => string };

const ACTIONS: Action[] = ["status", "authenticate", "reauthenticate", "refresh", "clear-cache", "tools"];
const FIELDS: Field[] = ["name", "transport", "target", "auth", "env", "scope", "lifecycle"];
const CSI = "\x1b[";
const color = (c: string, s: string) => `${CSI}${c}m${s}${CSI}0m`;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);
const score = (q: string, s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
const tokens = (tool: CachedTool) => Math.ceil((tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.inputSchema ?? {}).length) / 4) + 10;
const cycle = <T,>(xs: readonly T[], x: T, d: number) => xs[(Math.max(0, xs.indexOf(x)) + d + xs.length) % xs.length]!;

interface ToolState { name: string; description: string; direct: boolean; wasDirect: boolean; tokens: number }
interface ServerState { name: string; source: string; importKind?: string; expanded: boolean; toolsOpen: boolean; status: Status; tools: ToolState[]; cached: boolean; exposeResources: boolean; excludeTools?: string[] }
interface Draft { name: string; transport: "http" | "stdio"; target: string; auth: "auto" | "oauth" | "none" | "bearer-env"; env: string; scope: "user" | "project"; lifecycle: "lazy" | "eager" | "keep-alive" }
const newDraft = (): Draft => ({ name: "", transport: "http", target: "", auth: "auto", env: "", scope: "user", lifecycle: "lazy" });

function entryFromDraft(d: Draft): ServerEntry {
  const parts = d.target.trim().split(/\s+/).filter(Boolean);
  const entry: ServerEntry = d.transport === "http"
    ? { url: d.target.trim(), lifecycle: d.lifecycle }
    : { command: parts[0] ?? "", args: parts.slice(1), lifecycle: d.lifecycle };
  if (d.auth === "oauth") entry.auth = "oauth";
  if (d.auth === "none") entry.auth = false;
  if (d.auth === "bearer-env") {
    entry.auth = "bearer";
    entry.bearerTokenEnv = d.env || `${d.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MCP_TOKEN`;
  }
  return entry;
}

class Panel {
  private servers: ServerState[] = [];
  private items: Item[] = [];
  private cursor = 0;
  private query = "";
  private notice = "";
  private dirty = false;
  private confirmDiscard = false;
  private authInFlight = new Set<string>();
  private addMode = false;
  private draft = newDraft();
  private field = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private prefix: "server" | "none" | "short";

  constructor(
    config: McpConfig,
    cache: MetadataCache | null,
    provenance: Map<string, ServerProvenance>,
    private callbacks: McpPanelCallbacks,
    private tui: { requestRender(): void },
    private done: (result: McpPanelResult) => void,
    private opts: PanelOptions = {},
  ) {
    this.prefix = config.settings?.toolPrefix ?? "server";
    for (const [name, def] of Object.entries(config.mcpServers)) {
      if (opts.authOnly && !callbacks.canAuthenticate(name)) continue;
      const prov = provenance.get(name);
      const sc = cache?.servers?.[name];
      const directCfg = def.directTools ?? config.settings?.directTools ?? false;
      const tools: ToolState[] = [];
      if (sc && !opts.authOnly) {
        for (const tool of sc.tools ?? []) if (!isToolExcluded(tool.name, name, this.prefix, def.excludeTools)) {
          const direct = directCfg === true || (Array.isArray(directCfg) && directCfg.includes(tool.name));
          tools.push({ name: tool.name, description: tool.description ?? "", direct, wasDirect: direct, tokens: tokens(tool) });
        }
        if (def.exposeResources !== false) for (const resource of sc.resources ?? []) {
          const toolName = `get_${resourceNameToToolName(resource.name)}`;
          if (isToolExcluded(toolName, name, this.prefix, def.excludeTools)) continue;
          const direct = directCfg === true || (Array.isArray(directCfg) && directCfg.includes(toolName));
          tools.push({ name: toolName, description: resource.description ?? `Read resource: ${resource.uri}`, direct, wasDirect: direct, tokens: tokens({ name: toolName, description: resource.description }) });
        }
      }
      this.servers.push({ name, source: prov?.kind ?? "user", importKind: prov?.importKind, expanded: false, toolsOpen: true, status: callbacks.getConnectionStatus(name), tools, cached: !!sc, exposeResources: def.exposeResources !== false, excludeTools: def.excludeTools });
    }
    this.rebuild();
    this.armTimer();
  }

  private armTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(true), 60_000);
    this.timer.unref?.();
  }
  dispose() { if (this.timer) clearTimeout(this.timer); }
  invalidate() { this.rebuild(); }
  private close(cancelled = false, addedServer?: string) { this.dispose(); this.done(cancelled ? { cancelled, changes: new Map() } : { ...this.result(), addedServer }); }

  private rebuild() {
    this.items = [];
    for (let s = 0; s < this.servers.length; s++) {
      const server = this.servers[s]!;
      const matchingTools = server.tools.map((tool, t) => ({ tool, t })).filter(({ tool }) => score(this.query, tool.name) || score(this.query, tool.description));
      if (!this.query || score(this.query, server.name) || matchingTools.length > 0) this.items.push({ type: "server", s });
      if (this.query) for (const { t } of matchingTools) this.items.push({ type: "tool", s, t });
      else if (server.expanded && !this.opts.authOnly) {
        for (const action of ACTIONS) this.items.push({ type: "action", s, action });
        if (server.toolsOpen) for (let t = 0; t < server.tools.length; t++) this.items.push({ type: "tool", s, t });
      }
    }
    if (!this.opts.authOnly && !this.query && this.callbacks.addServer) this.items.push({ type: "add" });
    this.cursor = Math.min(this.cursor, Math.max(0, this.items.length - 1));
  }

  private result(): McpPanelResult {
    const changes = new Map<string, true | string[] | false>();
    for (const server of this.servers) {
      if (!server.tools.some(t => t.direct !== t.wasDirect)) continue;
      const direct = server.tools.filter(t => t.direct).map(t => t.name);
      changes.set(server.name, direct.length === server.tools.length && direct.length > 0 ? true : direct.length ? direct : false);
    }
    return { cancelled: false, changes };
  }
  private updateDirty() { this.dirty = this.servers.some(s => s.tools.some(t => t.direct !== t.wasDirect)); }

  handleInput(data: string) {
    this.armTimer();
    if (this.addMode) return this.handleAdd(data);
    if (this.confirmDiscard) return this.handleDiscard(data);
    if (matchesKey(data, "ctrl+c")) return this.close(true);
    if (matchesKey(data, "ctrl+s")) return this.close(false);
    if (matchesKey(data, "escape")) {
      if (this.query) { this.query = ""; this.rebuild(); return; }
      if (this.dirty) { this.confirmDiscard = true; return; }
      return this.close(true);
    }
    if (matchesKey(data, "up")) { this.cursor = Math.max(0, this.cursor - 1); return; }
    if (matchesKey(data, "down")) { this.cursor = Math.min(Math.max(0, this.items.length - 1), this.cursor + 1); return; }
    if ((data === "a" || data === "A") && !this.opts.authOnly && this.callbacks.addServer) { this.addMode = true; this.draft = newDraft(); this.field = 0; this.tui.requestRender(); return; }
    if (matchesKey(data, "space")) return this.toggle(this.items[this.cursor]);
    if (matchesKey(data, "return")) return this.activate(this.items[this.cursor]);
    if (matchesKey(data, "ctrl+a")) return this.authFor(this.items[this.cursor], false);
    if (matchesKey(data, "ctrl+r")) return this.refreshFor(this.items[this.cursor]);
    if (data === "?" && this.opts.authOnly) return;
    if (matchesKey(data, "backspace")) { this.query = this.query.slice(0, -1); this.rebuild(); return; }
    if (data.length === 1 && data.charCodeAt(0) >= 32) { this.query += data; this.rebuild(); }
  }

  private activate(item?: Item) {
    if (!item) return;
    if (item.type === "add") { this.addMode = true; this.draft = newDraft(); this.field = 0; return; }
    const server = this.servers[item.s]!;
    if (item.type === "server") {
      if (server.status === "connecting") return;
      if (this.opts.authOnly || server.status === "needs-auth") return this.authenticate(server, false);
      server.expanded = !server.expanded; server.toolsOpen = true; this.rebuild(); return;
    }
    if (item.type === "tool") { const tool = server.tools[item.t]; if (tool) this.notice = `${server.name}/${tool.name}: Space toggles direct, ctrl+s saves.`; return; }
    if (item.action === "status") { server.status = this.callbacks.getConnectionStatus(server.name); this.notice = `${server.name}: ${this.statusText(server)}`; return; }
    if (item.action === "authenticate") return this.authenticate(server, false);
    if (item.action === "reauthenticate") return this.authenticate(server, true);
    if (item.action === "refresh") return this.refresh(server);
    if (item.action === "clear-cache") return this.clear(server);
    server.toolsOpen = !server.toolsOpen; this.rebuild();
  }

  private toggle(item?: Item) {
    if (!item || this.opts.authOnly) return;
    const server = item.type === "server" || item.type === "tool" ? this.servers[item.s]! : undefined;
    if (!server) return;
    if (item.type === "server") {
      const next = !server.tools.every(t => t.direct);
      for (const tool of server.tools) tool.direct = next;
    } else if (item.type === "tool") {
      const tool = server.tools[item.t]; if (tool) tool.direct = !tool.direct;
    }
    this.updateDirty();
  }

  private authFor(item: Item | undefined, reauth: boolean) { if (item && item.type !== "add") this.authenticate(this.servers[item.s]!, reauth); }
  private refreshFor(item?: Item) { if (item && item.type !== "add") this.refresh(this.servers[item.s]!); }
  private authenticate(server: ServerState, reauth: boolean) {
    if (this.authInFlight.has(server.name)) return;
    if (!this.callbacks.canAuthenticate(server.name)) { this.notice = `${server.name} is not OAuth-capable.`; return; }
    this.authInFlight.add(server.name);
    server.status = "connecting"; this.notice = `${reauth ? "Re-authenticating" : "Authenticating"} ${server.name}...`; this.tui.requestRender();
    const p = reauth
      ? (this.callbacks.reauthenticate?.(server.name) ?? this.callbacks.authenticate(server.name))
      : this.callbacks.authenticate(server.name);
    p.then(r => {
      server.status = this.callbacks.getConnectionStatus(server.name);
      this.notice = r.ok ? `OAuth finished for ${server.name}` : `OAuth failed for ${server.name}: ${r.message ?? "unknown error"}`;
      this.authInFlight.delete(server.name);
      this.tui.requestRender();
    }).catch(e => {
      server.status = this.callbacks.getConnectionStatus(server.name);
      this.notice = `OAuth failed for ${server.name}: ${msg(e)}`;
      this.authInFlight.delete(server.name);
      this.tui.requestRender();
    });
  }
  private refresh(server: ServerState) {
    server.status = "connecting"; this.notice = `Refreshing ${server.name}...`; this.tui.requestRender();
    this.callbacks.reconnect(server.name).then(() => {
      server.status = this.callbacks.getConnectionStatus(server.name);
      const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
      if (entry) this.rebuildTools(server, entry);
      server.cached = !!entry; this.notice = `${server.name}: ${this.statusText(server)}`; this.tui.requestRender();
    }).catch(e => { server.status = "failed"; this.notice = `${server.name}: ${msg(e)}`; this.tui.requestRender(); });
  }
  private clear(server: ServerState) {
    if (!this.callbacks.clearServerCache) { this.notice = "Clear cache is unavailable."; return; }
    this.callbacks.clearServerCache(server.name).then(removed => { server.tools = []; server.cached = false; this.updateDirty(); this.rebuild(); this.notice = removed ? `${server.name}: cache cleared.` : `${server.name}: no cache entry.`; this.tui.requestRender(); })
      .catch(e => { this.notice = `${server.name}: ${msg(e)}`; this.tui.requestRender(); });
  }
  private rebuildTools(server: ServerState, entry: ServerCacheEntry) {
    server.tools = [];
    for (const tool of entry.tools ?? []) if (!isToolExcluded(tool.name, server.name, this.prefix, server.excludeTools)) server.tools.push({ name: tool.name, description: tool.description ?? "", direct: false, wasDirect: false, tokens: tokens(tool) });
    if (server.exposeResources) for (const resource of entry.resources ?? []) {
      const name = `get_${resourceNameToToolName(resource.name)}`;
      if (!isToolExcluded(name, server.name, this.prefix, server.excludeTools)) server.tools.push({ name, description: resource.description ?? `Read resource: ${resource.uri}`, direct: false, wasDirect: false, tokens: tokens({ name, description: resource.description }) });
    }
    this.rebuild();
  }

  private handleDiscard(data: string) { if (matchesKey(data, "return") || data === "y" || data === "Y") this.close(true); else if (matchesKey(data, "escape") || data === "n" || data === "N") this.confirmDiscard = false; }
  private handleAdd(data: string) {
    const field = FIELDS[this.field]!;
    if (matchesKey(data, "ctrl+c")) return this.close(true);
    if (matchesKey(data, "escape")) { this.addMode = false; this.notice = ""; return; }
    if (matchesKey(data, "up")) { this.field = Math.max(0, this.field - 1); return; }
    if (matchesKey(data, "down") || matchesKey(data, "tab")) { this.field = Math.min(FIELDS.length - 1, this.field + 1); return; }
    if (matchesKey(data, "left") || matchesKey(data, "right")) { this.cycleField(field, matchesKey(data, "right") ? 1 : -1); return; }
    if (matchesKey(data, "backspace")) { if (field === "name") this.draft.name = this.draft.name.slice(0, -1); if (field === "target") this.draft.target = this.draft.target.slice(0, -1); if (field === "env") this.draft.env = this.draft.env.slice(0, -1); return; }
    if (matchesKey(data, "return")) { if (this.field < FIELDS.length - 1) { this.field++; return; } return this.submitAdd(); }
    if (data.length === 1 && data.charCodeAt(0) >= 32) { if (field === "name") this.draft.name += data; if (field === "target") this.draft.target += data; if (field === "env") this.draft.env += data; }
  }
  private cycleField(field: Field, d: number) {
    if (field === "transport") this.draft.transport = cycle(["http", "stdio"], this.draft.transport, d);
    if (field === "auth") this.draft.auth = cycle(["auto", "oauth", "none", "bearer-env"], this.draft.auth, d);
    if (field === "scope") this.draft.scope = cycle(["user", "project"], this.draft.scope, d);
    if (field === "lifecycle") this.draft.lifecycle = cycle(["lazy", "eager", "keep-alive"], this.draft.lifecycle, d);
  }
  private submitAdd() {
    const name = this.draft.name.trim();
    if (!this.callbacks.addServer) { this.notice = "Add server is unavailable."; return; }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) { this.notice = "Invalid server name."; return; }
    if (!this.draft.target.trim()) { this.notice = "Target is required."; return; }
    const entry = entryFromDraft(this.draft);
    if (this.draft.transport === "stdio" && !entry.command) { this.notice = "Command is required."; return; }
    this.callbacks.addServer(name, entry, this.draft.scope).then(() => this.close(false, name)).catch(e => { this.notice = msg(e); this.tui.requestRender(); });
  }

  private statusText(server: ServerState) { return server.status === "connected" ? `connected (${server.tools.length} tools)` : server.status === "needs-auth" ? "needs auth" : server.status; }

  render(width: number): string[] {
    const w = Math.max(30, width - 2);
    const row = (s = "") => color("2", "│") + truncateToWidth(" " + s, w, "…", true) + color("2", "│");
    const out = [color("2", "╭" + "─".repeat(w) + "╮")];
    out.push(row(color("1", this.addMode ? "Add MCP Server" : this.opts.authOnly ? "MCP OAuth" : "MCP Servers")));
    for (const line of this.opts.noticeLines ?? []) out.push(row(color("2", line)));
    if (this.notice) out.push(row(color("33", this.notice)));
    if (this.confirmDiscard) { out.push(row(color("31", "Discard unsaved changes? Enter=yes Esc=no"))); out.push(color("2", "╰" + "─".repeat(w) + "╯")); return out; }
    if (this.addMode) return this.renderAdd(out, row, w);
    out.push(row(this.query ? `Search: ${this.query}` : color("2;3", "Type to search · a add server · Enter expand/action · Space toggle direct")));
    const start = Math.max(0, Math.min(this.cursor - 6, this.items.length - 12));
    const end = Math.min(this.items.length, start + 12);
    for (let i = start; i < end; i++) {
      const label = this.itemLabel(this.items[i]!);
      out.push(row(i === this.cursor ? this.selectedLabel(label) : label));
    }
    const direct = this.servers.reduce((n, s) => n + s.tools.filter(t => t.direct).length, 0);
    const toks = this.servers.reduce((n, s) => n + s.tools.filter(t => t.direct).reduce((a, t) => a + t.tokens, 0), 0);
    out.push(row(`Direct: ${direct} tools · ~${toks} tokens${this.dirty ? color("33", " · unsaved") : ""}`));
    out.push(row(color("2", "ctrl+a auth · ctrl+r refresh · ctrl+s save · Esc close")));
    out.push(color("2", "╰" + "─".repeat(w) + "╯"));
    return out;
  }
  private selected(text: string) {
    return this.opts.selectedText?.(text) ?? color("36", text);
  }

  private selectedLabel(label: string) {
    return this.selected(`› ${stripAnsi(label)}`);
  }

  private itemLabel(item: Item) {
    if (item.type === "add") return color("32", "+") + " Add MCP server";
    const s = item.type === "server" ? this.servers[item.s]! : this.servers[item.s]!;
    if (item.type === "server") return `${s.expanded ? "▾" : "▸"} ${s.status === "connected" ? color("32", "●") : s.status === "needs-auth" ? color("33", "●") : "○"} ${s.name} ${color("2", `(${s.source}${s.importKind ? ":" + s.importKind : ""}, ${s.tools.length} tools)`)}`;
    if (item.type === "tool") { const t = s.tools[item.t]!; return `    ${t.direct ? color("32", "✓") : color("2", "○")} ${t.name}${t.description ? color("2", " — " + t.description) : ""}`; }
    const labels: Record<Action, string> = { status: `Connection status: ${this.statusText(s)}`, authenticate: "Authenticate", reauthenticate: "Re-authenticate", refresh: "Reconnect / refresh tools", "clear-cache": "Clear cached tools", tools: `${s.toolsOpen ? "Hide" : "Show"} tools` };
    const disabled = (item.action === "authenticate" || item.action === "reauthenticate") && !this.callbacks.canAuthenticate(s.name);
    return "  • " + (disabled ? color("2", labels[item.action]) : labels[item.action]);
  }
  private renderAdd(out: string[], row: (s?: string) => string, w: number) {
    const values: Record<Field, string> = { name: this.draft.name || color("2;3", "my-server"), transport: this.draft.transport, target: this.draft.target || color("2;3", this.draft.transport === "http" ? "https://example.com/mcp" : "npx -y package"), auth: this.draft.auth, env: this.draft.env || color("2;3", "TOKEN_ENV for bearer-env"), scope: this.draft.scope, lifecycle: this.draft.lifecycle };
    out.push(row(color("2", "Enter text; left/right cycles options; Esc cancels")));
    for (let i = 0; i < FIELDS.length; i++) out.push(row(`${i === this.field ? this.selected("›") : " "} ${FIELDS[i]!.padEnd(10)} ${values[FIELDS[i]!]}`));
    out.push(row(color("2", "Enter on lifecycle adds server. User scope writes private Pi config.")));
    out.push(color("2", "╰" + "─".repeat(w) + "╯"));
    return out;
  }
}

class SafePanel {
  private error = "";
  constructor(private inner: Panel, private tui: { requestRender(): void }, private done: (result: McpPanelResult) => void) {}
  handleInput(data: string) { if (this.error && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) return this.done({ cancelled: true, changes: new Map() }); try { this.inner.handleInput(data); } catch (e) { this.error = msg(e); this.tui.requestRender(); } }
  render(width: number) { if (this.error) return [`MCP panel error: ${this.error}`, "Press Esc to close."]; try { return this.inner.render(width); } catch (e) { this.error = msg(e); return this.render(width); } }
  invalidate() { this.inner.invalidate(); }
  dispose() { this.inner.dispose(); }
}

export function createMcpPanel(config: McpConfig, cache: MetadataCache | null, provenance: Map<string, ServerProvenance>, callbacks: McpPanelCallbacks, tui: { requestRender(): void }, done: (result: McpPanelResult) => void, options?: PanelOptions): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; dispose(): void } {
  const panel = new Panel(config, cache, provenance, callbacks, tui, done, options);
  return new SafePanel(panel, tui, done);
}
