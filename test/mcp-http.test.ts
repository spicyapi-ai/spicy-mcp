import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { startHttpServer } from "../src/mcp/http.js";

const token = "mcp_http_token_0123456789abcdef0123456789";

void test("MCP HTTP refuses remote binding and weak or reused tokens", async () => {
  await assert.rejects(
    startHttpServer({ host: "0.0.0.0", port: 0, token }),
    /remote MCP HTTP is disabled/,
  );
  await assert.rejects(startHttpServer({ port: 0, token: "short" }), /at least 32 bytes/);
  await assert.rejects(
    startHttpServer({ port: 0, token, clientOptions: { apiKey: token } }),
    /must be separate from SPICY_API_KEY/,
  );
});

function chunkedPost(
  url: string,
  authorization: string,
  body: Buffer,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    });
    outgoing.once("error", reject);
    outgoing.once("response", (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(incoming.statusCode));
    });
    outgoing.end(body);
  });
}

void test("loopback MCP HTTP enforces auth and completes a modern handshake", async () => {
  const handle = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    token,
    clientOptions: {
      apiKey: "sk_http_api",
      apiBaseUrl: "http://127.0.0.1:4040/api/v1",
      serviceBaseUrl: "http://127.0.0.1:4040",
      fetch: () => Promise.reject(new Error("API should not be called by discovery")),
    },
    stateSecret: "abcdef0123456789abcdef0123456789",
    onError: () => undefined,
  });
  const client = new Client(
    { name: "spicy-http-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    const healthUrl = new URL("/healthz", handle.url);
    const health = await fetch(healthUrl);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer/);

    const badOrigin = await fetch(handle.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: "{}",
    });
    assert.equal(badOrigin.status, 403);

    const oversized = await chunkedPost(
      handle.url,
      `Bearer ${token}`,
      Buffer.alloc(2 * 1_024 * 1_024 + 1, 0x20),
    );
    assert.equal(oversized, 413);

    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      authProvider: { token: () => Promise.resolve(token) },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 22);
    assert.ok(tools.tools.some((tool) => tool.name === "spicyapi_usage_get"));
    assert.ok(tools.tools.some((tool) => tool.name === "spicyapi_tasks_list"));
    assert.ok(tools.tools.some((tool) => tool.name === "spicyapi_task_create"));
  } finally {
    await client.close();
    await handle.close();
  }
});
