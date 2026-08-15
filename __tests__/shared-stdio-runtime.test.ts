import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SharedStdioClientTransport } from "../shared-stdio-transport.ts";

const fixture = resolve(import.meta.dirname, "fixtures/shared-stdio-server.mjs");
const clients: Client[] = [];
let runtimeDir: string;

function options(hash: string) {
  return {
    serverName: "shared-fixture",
    definitionHash: hash,
    definition: {
      command: process.execPath,
      args: [fixture],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stderr: "ignore" as const,
    },
    idleMs: 1_000,
  };
}

async function connect(hash: string): Promise<Client> {
  const client = new Client({ name: `shared-test-${clients.length}`, version: "1.0.0" });
  clients.push(client);
  await client.connect(new SharedStdioClientTransport(options(hash)));
  return client;
}

async function identity(client: Client, delay = 0): Promise<{ pid: number; calls: number }> {
  const result = await client.callTool({ name: "identity", arguments: { delay } });
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Fixture returned no identity");
  return JSON.parse(block.text) as { pid: number; calls: number };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for shared runtime state");
}

describe("shared stdio runtime", () => {
  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), "pi-mcp-shared-test-"));
    process.env.MCP_SHARED_RUNTIME_DIR = runtimeDir;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close().catch(() => {})));
    for (const file of readdirSync(runtimeDir).filter(name => name.endsWith(".json"))) {
      try {
        const info = JSON.parse(readFileSync(join(runtimeDir, file), "utf8")) as { pid?: number };
        if (info.pid) process.kill(info.pid, "SIGTERM");
      } catch {}
    }
    delete process.env.MCP_SHARED_RUNTIME_DIR;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("multiplexes concurrent clients through one upstream process", async () => {
    const hash = "a".repeat(64);
    const [first, second] = await Promise.all([connect(hash), connect(hash)]);

    await expect(first.listTools()).resolves.toMatchObject({ tools: [{ name: "identity" }] });
    const [one, two] = await Promise.all([identity(first, 30), identity(second, 5)]);

    expect(one.pid).toBe(two.pid);
    expect(new Set([one.calls, two.calls])).toEqual(new Set([1, 2]));
    expect(readdirSync(runtimeDir).filter(name => name.endsWith(".json"))).toHaveLength(1);

    await first.close();
    const three = await identity(second);
    expect(three).toEqual({ pid: one.pid, calls: 3 });

    await second.close();
    await waitFor(() => readdirSync(runtimeDir).filter(name => name.endsWith(".json")).length === 0);
  });

  it("recovers from a broker killed without cleanup", async () => {
    const hash = "b".repeat(64);
    const first = await connect(hash);
    const before = await identity(first);
    const infoPath = join(runtimeDir, readdirSync(runtimeDir).find(name => name.endsWith(".json"))!);
    const info = JSON.parse(readFileSync(infoPath, "utf8")) as { pid: number };

    process.kill(info.pid, "SIGKILL");
    await waitFor(() => {
      try { process.kill(info.pid, 0); return false; }
      catch { return true; }
    });

    const second = await connect(hash);
    const after = await identity(second);
    expect(after.pid).not.toBe(before.pid);
  });
});
