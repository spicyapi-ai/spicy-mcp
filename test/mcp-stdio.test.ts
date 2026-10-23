import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

function transport(): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp/stdio.js", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      SPICY_API_KEY: "sk_stdio_protocol_test",
    },
    stderr: "pipe",
  });
}

void test("stdio entrypoint negotiates modern MCP through a real child process", async () => {
  const client = new Client(
    { name: "spicy-stdio-modern-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(transport());
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 22);
    assert.ok(tools.tools.some((tool) => tool.name === "spicyapi_usage_get"));
    assert.ok(tools.tools.some((tool) => tool.name === "spicyapi_tasks_list"));
    const result = await client.callTool({
      name: "spicyapi_docs_search",
      arguments: { query: "webhook", limit: 2 },
    });
    assert.equal(result.isError, undefined);
  } finally {
    await client.close();
  }
});

void test("stdio entrypoint retains legacy MCP compatibility", async () => {
  const client = new Client(
    { name: "spicy-stdio-legacy-test", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  try {
    await client.connect(transport());
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
      "spicyapi://contract/openapi",
      "spicyapi://docs/index",
    ]);
  } finally {
    await client.close();
  }
});
