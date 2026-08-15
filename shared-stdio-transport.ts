import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getAgentPath } from "./agent-dir.ts";

const BROKER_PROTOCOL = 1;
const START_TIMEOUT_MS = 10_000;
const BROKER_IDLE_MS = 30_000;

interface BrokerInfo {
  protocol: number;
  pid: number;
  port: number;
  token: string;
  definitionHash: string;
}

export interface SharedStdioDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: "inherit" | "ignore" | "pipe";
}

export interface SharedStdioTransportOptions {
  serverName: string;
  definitionHash: string;
  definition: SharedStdioDefinition;
  idleMs?: number;
}

function getSharedRuntimeDir(): string {
  return process.env.MCP_SHARED_RUNTIME_DIR?.trim() || getAgentPath("state", "mcp-shared");
}

function pathsFor(hash: string): { infoPath: string; lockPath: string } {
  const directory = getSharedRuntimeDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = hash.slice(0, 24);
  return { infoPath: join(directory, `${key}.json`), lockPath: join(directory, `${key}.lock`) };
}

function readInfo(path: string, definitionHash: string): BrokerInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as BrokerInfo;
    if (value.protocol !== BROKER_PROTOCOL || value.definitionHash !== definitionHash) return undefined;
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.port) || !value.token) return undefined;
    process.kill(value.pid, 0);
    return value;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseOwner(path: string): { pid?: number } {
  try { return JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: number }; }
  catch { return {}; }
}

async function acquireStartupLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, ownerId: randomUUID(), createdAt: Date.now() }), { mode: 0o600 });
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      const owner = parseOwner(lockPath);
      if (owner.pid && !isProcessAlive(owner.pid)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !owner.pid) throw error;
      await sleep(50);
    }
  }
  throw new Error("Timed out waiting for shared MCP runtime startup lock");
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const onError = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("error", onError);
    socket.once("connect", () => { socket.off("error", onError); resolve(socket); });
  });
}

async function connectAndHandshake(info: BrokerInfo, options: SharedStdioTransportOptions): Promise<Socket> {
  const socket = await connectSocket(info.port);
  socket.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => fail(new Error(`Timed out connecting to shared MCP runtime for ${options.serverName}`)), START_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const onClose = () => fail(new Error(`Shared MCP runtime closed during startup for ${options.serverName}`));
    const onData = (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let envelope: { type?: string; message?: string };
      try { envelope = JSON.parse(buffer.slice(0, newline)) as { type?: string; message?: string }; }
      catch { fail(new Error("Shared MCP runtime returned an invalid handshake")); return; }
      if (envelope.type === "ready") { cleanup(); resolve(socket); return; }
      fail(new Error(envelope.message || "Shared MCP runtime rejected the connection"));
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", onClose);
    socket.write(`${JSON.stringify({ type: "hello", token: info.token, definitionHash: options.definitionHash, definition: options.definition })}\n`);
  });
}

async function waitForBroker(infoPath: string, options: SharedStdioTransportOptions): Promise<Socket> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const info = readInfo(infoPath, options.definitionHash);
    if (info) {
      try { return await connectAndHandshake(info, options); }
      catch (error) { lastError = error; }
    }
    await sleep(50);
  }
  throw lastError instanceof Error ? lastError : new Error(`Shared MCP runtime did not start for ${options.serverName}`);
}

async function openSharedSocket(options: SharedStdioTransportOptions): Promise<Socket> {
  const { infoPath, lockPath } = pathsFor(options.definitionHash);
  const current = readInfo(infoPath, options.definitionHash);
  if (current) {
    try { return await connectAndHandshake(current, options); }
    catch { rmSync(infoPath, { force: true }); }
  }

  const release = await acquireStartupLock(lockPath);
  try {
    const afterLock = readInfo(infoPath, options.definitionHash);
    if (afterLock) {
      try { return await connectAndHandshake(afterLock, options); }
      catch { rmSync(infoPath, { force: true }); }
    }
    rmSync(infoPath, { force: true });
    const brokerPath = fileURLToPath(new URL("./shared-stdio-broker.js", import.meta.url));
    const child = spawn(process.execPath, [brokerPath, infoPath, options.definitionHash, String(options.idleMs ?? BROKER_IDLE_MS)], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return await waitForBroker(infoPath, options);
  } finally {
    release();
  }
}

export class SharedStdioClientTransport implements Transport {
  private socket?: Socket;
  private buffer = "";
  private closed = false;
  private started = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly options: SharedStdioTransportOptions) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("SharedStdioClientTransport is already started");
    this.started = true;
    this.socket = await openSharedSocket(this.options);
    this.socket.on("data", chunk => this.handleData(chunk.toString()));
    this.socket.on("error", error => this.onerror?.(error));
    this.socket.on("close", () => this.finishClose());
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.socket || this.closed) throw new Error("Shared stdio transport is not connected");
    const line = `${JSON.stringify({ type: "message", message })}\n`;
    if (!this.socket.write(line)) await new Promise<void>(resolve => this.socket!.once("drain", resolve));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      await new Promise<void>(resolve => {
        socket.once("close", resolve);
        socket.end();
        setTimeout(() => { socket.destroy(); resolve(); }, 100).unref();
      });
    }
    this.onclose?.();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let envelope: { type?: string; message?: JSONRPCMessage | string };
      try { envelope = JSON.parse(line) as { type?: string; message?: JSONRPCMessage | string }; }
      catch { this.onerror?.(new Error("Shared MCP runtime sent invalid JSON")); continue; }
      if (envelope.type === "message" && envelope.message && typeof envelope.message === "object") this.onmessage?.(envelope.message);
      else if (envelope.type === "error") this.onerror?.(new Error(typeof envelope.message === "string" ? envelope.message : "Shared MCP runtime error"));
      else if (envelope.type === "close") void this.close();
    }
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = undefined;
    this.onclose?.();
  }
}
