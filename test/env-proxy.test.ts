import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { shouldRelaunchWithEnvProxy, supportsEnvProxy } from "../src/runtime/env-proxy.js";

const PROXY = "http://127.0.0.1:7890";
const SUPPORTED = "22.22.1";

void test("relaunches for an http(s) proxy on a runtime that can use it", () => {
  for (const env of [
    { HTTPS_PROXY: PROXY },
    { https_proxy: "https://proxy.internal:8443" },
    { HTTP_PROXY: PROXY },
    { http_proxy: PROXY, HTTPS_PROXY: "" },
  ]) {
    assert.equal(shouldRelaunchWithEnvProxy({ env, execArgv: [], version: SUPPORTED }), true);
  }
});

/* Every one of these would make a restart useless or harmful. */
void test("does not relaunch when it would change nothing or break the start", () => {
  const cases: Array<[string, NodeJS.ProcessEnv, readonly string[], string]> = [
    ["no proxy at all", {}, [], SUPPORTED],
    ["empty proxy values", { HTTPS_PROXY: "", http_proxy: "" }, [], SUPPORTED],
    // Node.js will not start with these once the switch is on.
    ["socks proxy", { HTTPS_PROXY: "socks5://127.0.0.1:7890" }, [], SUPPORTED],
    ["bare host:port", { HTTPS_PROXY: "127.0.0.1:7890" }, [], SUPPORTED],
    ["one usable, one not", { HTTPS_PROXY: PROXY, http_proxy: "socks5://h:1" }, [], SUPPORTED],
    // Already on, or explicitly off: `0` is the opt-out, and `1` is the restarted process.
    ["already on", { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: "1" }, [], SUPPORTED],
    ["opted out", { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: "0" }, [], SUPPORTED],
    ["flag in execArgv", { HTTPS_PROXY: PROXY }, ["--use-env-proxy"], SUPPORTED],
    [
      "flag in NODE_OPTIONS",
      { HTTPS_PROXY: PROXY, NODE_OPTIONS: "--use-env-proxy" },
      [],
      SUPPORTED,
    ],
    ["runtime too old", { HTTPS_PROXY: PROXY }, [], "22.20.0"],
  ];
  for (const [name, env, execArgv, version] of cases) {
    assert.equal(shouldRelaunchWithEnvProxy({ env, execArgv, version }), false, name);
  }
});

void test("env proxy support starts at Node.js 22.21 and 24.0", () => {
  assert.equal(supportsEnvProxy("22.13.0"), false);
  assert.equal(supportsEnvProxy("22.20.9"), false);
  assert.equal(supportsEnvProxy("22.21.0"), true);
  assert.equal(supportsEnvProxy("23.11.0"), false);
  assert.equal(supportsEnvProxy("24.0.0"), true);
  assert.equal(supportsEnvProxy("26.1.0"), true);
});

/* A proxy that records where it was asked to tunnel and refuses, so nothing leaves the machine. */
async function recordingProxy(): Promise<{ server: Server; url: string; tunnels: string[] }> {
  const tunnels: string[] = [];
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.on("connect", (request, socket) => {
    tunnels.push(request.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, tunnels };
}

/* Processes whose command line carries `marker`; the restart copies it into the child. */
function processesWith(marker: string): string[] {
  const listing = execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" });
  return listing.split("\n").filter((line) => line.includes(marker));
}

void test(
  "the stdio server speaks MCP through the restart and sends API calls through HTTPS_PROXY",
  {
    skip:
      process.platform === "win32"
        ? "the leftover-process check reads ps"
        : supportsEnvProxy()
          ? false
          : "this Node.js cannot use proxy variables",
  },
  async () => {
    const proxy = await recordingProxy();
    // An argument the server ignores, so this test's processes can be told from any other.
    const marker = `--env-proxy-test-${randomUUID()}`;
    const client = new Client({ name: "spicy-env-proxy-test", version: "1.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [fileURLToPath(new URL("../src/mcp/stdio.js", import.meta.url)), marker],
          env: {
            PATH: process.env.PATH ?? "",
            SPICY_API_KEY: "sk-spicy-envproxytest0000000000000000000000",
            // A reserved name: if the request ever went out directly it could not reach anyone.
            SPICY_API_BASE_URL: "https://api.spicyapi.invalid/api/v1",
            HTTPS_PROXY: proxy.url,
          },
          stderr: "pipe",
        }),
      );
      // Both processes exist: the one the client started, and the restarted one doing the work.
      assert.equal(processesWith(marker).length, 2);
      const result = await client.callTool({ name: "spicyapi_balance_get", arguments: {} });
      assert.equal(result.isError, true);
      assert.ok(proxy.tunnels.includes("api.spicyapi.invalid:443"), proxy.tunnels.join(","));
    } finally {
      await client.close();
      proxy.server.close();
    }
    // Closing the client must not leave the restarted server running on its own.
    for (let attempt = 0; attempt < 50 && processesWith(marker).length > 0; attempt += 1) {
      await delay(100);
    }
    assert.deepEqual(processesWith(marker), []);
  },
);
