import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The repository root doubles as an Agent Plugins package (agent-plugins.org), which is how
// directories such as cursor.directory discover this server. Those two manifests repeat facts that
// live in package.json, so they can drift silently: a renamed package or binary would leave every
// plugin install launching a command that no longer exists.
const repoRoot = new URL("../../", import.meta.url);

function readJson(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(new URL(name, repoRoot), "utf8"));
  assert.equal(typeof parsed, "object", `${name} should parse into an object`);
  assert.notEqual(parsed, null, `${name} should not be null`);
  return parsed as Record<string, unknown>;
}

const packageJson = readJson("package.json");
const pluginJson = readJson("plugin.json");
const mcpJson = readJson("mcp.json");

void test("the fixtures this file asserts against are actually loaded", () => {
  // Counter-evidence: without this, a lookup that silently returned undefined on both sides would
  // make every comparison below pass.
  assert.equal(packageJson["name"], "@spicyapi/mcp");
  assert.equal(typeof packageJson["version"], "string");
  assert.ok(Object.keys(packageJson["bin"] as Record<string, string>).length > 0);
});

void test("plugin.json declares the published version", () => {
  assert.equal(pluginJson["version"], packageJson["version"]);
});

void test("plugin.json targets the Agent Plugins 1.0.0 manifest schema", () => {
  assert.equal(pluginJson["$schema"], "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(pluginJson["name"] as string, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
});

void test("mcp.json launches the binary this package actually ships", () => {
  assert.equal(mcpJson["$schema"], "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");

  const servers = mcpJson["mcpServers"] as Record<string, Record<string, unknown>>;
  const server = servers["spicyapi"];
  assert.ok(server, "mcp.json should configure a server named spicyapi");

  assert.equal(server["type"], "stdio");
  assert.equal(server["command"], "npx");

  const args = server["args"] as string[];
  // npx needs --package= because this package ships two binaries; without it npx fails with
  // "could not determine executable to run".
  assert.ok(
    args.includes(`--package=${packageJson["name"] as string}`),
    `mcp.json should pass --package=${packageJson["name"] as string} to npx`,
  );
  const binaries = Object.keys(packageJson["bin"] as Record<string, string>);
  assert.ok(
    args.some((arg) => binaries.includes(arg)),
    `mcp.json should invoke one of the binaries in package.json: ${binaries.join(", ")}`,
  );
});
