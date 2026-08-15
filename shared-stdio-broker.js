import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BROKER_PROTOCOL = 1;
const [infoPath, definitionHash, idleArg] = process.argv.slice(2);
const idleMs = Math.max(1_000, Number(idleArg) || 30_000);
if (!infoPath || !definitionHash) throw new Error("Shared MCP broker requires info path and definition hash");

const token = randomUUID();
const clients = new Map();
const requestRoutes = new Map();
const progressRoutes = new Map();
let nextClientId = 1;
let nextRequestId = 1;
let upstream;
let upstreamStart;
let initState = "new";
let initRequestId;
let initResult;
let initializedForwarded = false;
let pendingInitializers = [];
let idleTimer;
let stopping = false;

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function send(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function sendMessage(client, message) {
  send(client.socket, { type: "message", message });
}

function clone(value) {
  return structuredClone(value);
}

function writeInfo(port) {
  mkdirSync(dirname(infoPath), { recursive: true, mode: 0o700 });
  const tempPath = `${infoPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ protocol: BROKER_PROTOCOL, pid: process.pid, port, token, definitionHash }), { mode: 0o600 });
  renameSync(tempPath, infoPath);
}

function removeOwnInfo() {
  try {
    const current = JSON.parse(readFileSync(infoPath, "utf8"));
    if (current.pid === process.pid && current.token === token) rmSync(infoPath, { force: true });
  } catch {}
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

function armIdleTimer() {
  clearIdleTimer();
  if (clients.size > 0) return;
  idleTimer = setTimeout(() => void shutdown(0), idleMs);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearIdleTimer();
  removeOwnInfo();
  for (const client of clients.values()) {
    send(client.socket, { type: "close" });
    client.socket.destroy();
  }
  clients.clear();
  await upstream?.close().catch(() => {});
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 250).unref();
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  for (const client of clients.values()) send(client.socket, { type: "error", message });
}

async function ensureUpstream(definition) {
  if (upstreamStart) return upstreamStart;
  upstreamStart = (async () => {
    upstream = new StdioClientTransport(definition);
    upstream.onmessage = routeUpstreamMessage;
    upstream.onerror = fail;
    upstream.onclose = () => void shutdown(1);
    await upstream.start();
  })();
  try {
    await upstreamStart;
  } catch (error) {
    fail(error);
    await shutdown(1);
    throw error;
  }
}

function rewriteProgressToken(client, request, route) {
  const meta = request.params?._meta;
  if (!meta || meta.progressToken === undefined) return request;
  const original = meta.progressToken;
  const shared = `mux:${client.id}:${String(original)}:${nextRequestId}`;
  request.params = { ...request.params, _meta: { ...meta, progressToken: shared } };
  progressRoutes.set(idKey(shared), { client, original });
  route.progressToken = shared;
  return request;
}

async function forwardRequest(client, message) {
  const upstreamId = `mux:${nextRequestId++}`;
  const forwarded = clone(message);
  const route = { client, originalId: message.id };
  forwarded.id = upstreamId;
  rewriteProgressToken(client, forwarded, route);
  requestRoutes.set(idKey(upstreamId), route);
  client.requestIds.set(idKey(message.id), upstreamId);
  await upstream.send(forwarded);
}

async function routeClientMessage(client, message) {
  if (!message || typeof message !== "object") return;
  const isRequest = "method" in message && "id" in message;
  const isNotification = "method" in message && !("id" in message);

  if (isRequest && message.method === "initialize") {
    if (initState === "ready") {
      sendMessage(client, { jsonrpc: "2.0", id: message.id, result: clone(initResult) });
      return;
    }
    pendingInitializers.push({ client, id: message.id });
    if (initState === "pending") return;
    initState = "pending";
    initRequestId = `mux:${nextRequestId++}`;
    const forwarded = clone(message);
    forwarded.id = initRequestId;
    await upstream.send(forwarded);
    return;
  }

  if (isNotification && message.method === "notifications/initialized") {
    client.initialized = true;
    if (!initializedForwarded && initState === "ready") {
      initializedForwarded = true;
      await upstream.send(message);
    }
    return;
  }

  if (!client.initialized && initState !== "ready") {
    if (isRequest) sendMessage(client, { jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Shared MCP runtime is not initialized" } });
    return;
  }

  if (isNotification && message.method === "notifications/cancelled") {
    const originalId = message.params?.requestId;
    const upstreamId = client.requestIds.get(idKey(originalId));
    if (!upstreamId) return;
    const forwarded = clone(message);
    forwarded.params = { ...forwarded.params, requestId: upstreamId };
    await upstream.send(forwarded);
    return;
  }

  if (isRequest) {
    await forwardRequest(client, message);
    return;
  }

  if (isNotification) await upstream.send(message);
}

async function routeUpstreamMessage(message) {
  if (!message || typeof message !== "object") return;
  const isRequest = "method" in message && "id" in message;
  const isNotification = "method" in message && !("id" in message);
  const isResponse = "id" in message && !(("method") in message);

  if (isResponse && idKey(message.id) === idKey(initRequestId)) {
    const pending = pendingInitializers;
    pendingInitializers = [];
    if ("result" in message) {
      initResult = clone(message.result);
      initState = "ready";
      for (const item of pending) sendMessage(item.client, { jsonrpc: "2.0", id: item.id, result: clone(initResult) });
    } else {
      initState = "new";
      for (const item of pending) sendMessage(item.client, { jsonrpc: "2.0", id: item.id, error: clone(message.error) });
    }
    return;
  }

  if (isResponse) {
    const route = requestRoutes.get(idKey(message.id));
    if (!route) return;
    requestRoutes.delete(idKey(message.id));
    route.client.requestIds.delete(idKey(route.originalId));
    if (route.progressToken !== undefined) progressRoutes.delete(idKey(route.progressToken));
    const restored = clone(message);
    restored.id = route.originalId;
    sendMessage(route.client, restored);
    return;
  }

  if (isRequest) {
    const response = message.method === "ping"
      ? { jsonrpc: "2.0", id: message.id, result: {} }
      : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Server-to-client requests are unsupported by shared stdio runtimes; use runtime=session" } };
    await upstream.send(response);
    return;
  }

  if (isNotification && message.method === "notifications/progress") {
    const route = progressRoutes.get(idKey(message.params?.progressToken));
    if (route) {
      const restored = clone(message);
      restored.params = { ...restored.params, progressToken: route.original };
      sendMessage(route.client, restored);
      return;
    }
  }

  if (isNotification) for (const client of clients.values()) if (client.initialized) sendMessage(client, message);
}

function removeClient(client) {
  if (!clients.delete(client.socket)) return;
  for (const [key, route] of requestRoutes) {
    if (route.client !== client) continue;
    requestRoutes.delete(key);
    if (route.progressToken !== undefined) progressRoutes.delete(idKey(route.progressToken));
    void upstream?.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: key.slice(key.indexOf(":") + 1), reason: "Shared runtime client disconnected" } }).catch(() => {});
  }
  pendingInitializers = pendingInitializers.filter(item => item.client !== client);
  armIdleTimer();
}

function attachSocket(socket) {
  let buffer = "";
  let client;
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let envelope;
      try { envelope = JSON.parse(line); }
      catch { socket.destroy(); return; }
      if (!client) {
        if (envelope.type !== "hello" || envelope.token !== token || envelope.definitionHash !== definitionHash || !envelope.definition) {
          socket.destroy();
          return;
        }
        client = { id: nextClientId++, socket, initialized: false, requestIds: new Map() };
        clients.set(socket, client);
        clearIdleTimer();
        void ensureUpstream(envelope.definition).then(() => send(socket, { type: "ready" })).catch(() => socket.destroy());
        continue;
      }
      if (envelope.type === "message") void routeClientMessage(client, envelope.message).catch(error => send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }));
    }
  });
  socket.on("close", () => { if (client) removeClient(client); });
  socket.on("error", () => { if (client) removeClient(client); });
}

const server = createServer(attachSocket);
server.on("error", error => { fail(error); void shutdown(1); });
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Shared MCP broker failed to bind TCP endpoint");
  writeInfo(address.port);
  armIdleTimer();
});

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("uncaughtException", error => { fail(error); void shutdown(1); });
process.on("unhandledRejection", error => { fail(error); void shutdown(1); });
