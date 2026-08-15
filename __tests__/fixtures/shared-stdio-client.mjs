import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SharedStdioClientTransport } from "../../shared-stdio-transport.ts";

const [runtimeDir, definitionHash, fixture] = process.argv.slice(2);
process.env.MCP_SHARED_RUNTIME_DIR = runtimeDir;
const client = new Client({ name: `shared-child-${process.pid}`, version: "1.0.0" });
try {
  await client.connect(new SharedStdioClientTransport({
    serverName: "shared-child-fixture",
    definitionHash,
    definition: {
      command: process.execPath,
      args: [fixture],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: "ignore",
    },
    idleMs: 1_000,
  }));
  const result = await client.callTool({ name: "identity", arguments: { delay: 100 } });
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Fixture returned no identity");
  process.stdout.write(`${block.text}\n`);
} finally {
  await client.close().catch(() => {});
}
