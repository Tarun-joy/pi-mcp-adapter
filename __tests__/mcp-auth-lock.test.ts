import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireOAuthFlowLock, releaseOAuthFlowLock } from "../mcp-auth.ts";

describe("OAuth flow locks", () => {
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-lock-"));
    process.env.MCP_OAUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) delete process.env.MCP_OAUTH_DIR;
    else process.env.MCP_OAUTH_DIR = originalOAuthDir;
  });

  it("allows only one interactive flow per server across processes", () => {
    const lock = acquireOAuthFlowLock("huggingface");

    expect(() => acquireOAuthFlowLock("huggingface"))
      .toThrow(/already in progress/);

    releaseOAuthFlowLock(lock);
    const next = acquireOAuthFlowLock("huggingface");
    releaseOAuthFlowLock(next);
  });

  it("recovers a lock left by a process that no longer exists", () => {
    const lock = acquireOAuthFlowLock("huggingface");
    writeFileSync(lock.path, JSON.stringify({
      ownerId: "abandoned",
      pid: 2147483647,
      createdAt: Date.now(),
    }));

    const recovered = acquireOAuthFlowLock("huggingface");

    expect(recovered.ownerId).not.toBe("abandoned");
    releaseOAuthFlowLock(recovered);
  });
});
