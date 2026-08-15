import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let calls = 0;
const server = new Server(
  { name: "shared-stdio-fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "identity",
    description: "Return the upstream process identity",
    inputSchema: { type: "object", properties: { delay: { type: "number" } } },
  }],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const delay = Number(request.params.arguments?.delay ?? 0);
  const progressToken = request.params._meta?.progressToken;
  if (progressToken !== undefined) {
    await server.notification({
      method: "notifications/progress",
      params: { progressToken, progress: delay || 1, total: delay || 1 },
    });
  }
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  calls++;
  return { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, calls }) }] };
});

await server.connect(new StdioServerTransport());
