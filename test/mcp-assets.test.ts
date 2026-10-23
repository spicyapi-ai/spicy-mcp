import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { SpicyClient } from "@spicyapi/sdk";

import { createSpicyMcpFactory, SPICYAPI_MCP_TOOLS } from "../src/mcp/server.js";

const ASSET_TOOLS = [
  "spicyapi_assets_list",
  "spicyapi_asset_save",
  "spicyapi_asset_rename",
  "spicyapi_asset_delete",
  "spicyapi_assets_usage_get",
  "spicyapi_characters_list",
  "spicyapi_character_get",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

function recorder(responses: Array<Response | ((call: Call) => Response)>): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const implementation: typeof fetch = (input, init) => {
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input instanceof Request ? input.url : input)),
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    const next = responses.shift();
    if (!next) return Promise.reject(new Error(`unexpected request to ${call.url.href}`));
    return Promise.resolve(typeof next === "function" ? next(call) : next);
  };
  return { calls, fetch: implementation };
}

function envelope(data: unknown): Response {
  return Response.json({ code: 200, msg: "success", data, request_id: "req_mcp_asset" });
}

function failure(status: number, reason?: string): Response {
  return Response.json(
    {
      code: status,
      msg: "refused by the asset library",
      request_id: "req_mcp_fail",
      ...(reason === undefined ? {} : { data: { reason } }),
    },
    { status },
  );
}

function asset(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    uri: `spicy://a/${id}`,
    name: "Hero portrait",
    kind: "image",
    contentType: "image/png",
    bytes: 1843201,
    source: "task_output",
    sourceId: "job_1",
    createdAt: "2026-10-11T08:20:11Z",
    updatedAt: "2026-10-11T08:20:11Z",
    previewUrl: "https://preview.example/private",
    favorite: false,
    model: "bytedance/seedream-5.0-pro/text-to-image",
    modelName: "Seedream 5.0 Pro",
    ...overrides,
  };
}

function character(id: string, imageIds: string[]) {
  const images = imageIds.map((imageId) => asset(imageId));
  return {
    id,
    kind: "character",
    name: "Mia",
    note: "",
    coverAssetId: imageIds[0] ?? "",
    cover: images[0] ?? null,
    assets: images,
    count: images.length,
    createdAt: "2026-10-12T08:00:00Z",
    updatedAt: "2026-10-12T08:00:00Z",
  };
}

async function connect(
  fetchImplementation: typeof fetch,
  confirmation: "accept" | "decline" = "accept",
  messages: string[] = [],
  maxRetries = 0,
) {
  const handler = createMcpHandler(
    createSpicyMcpFactory({
      client: new SpicyClient({
        apiKey: "sk_mcp_assets",
        apiBaseUrl: "http://127.0.0.1:4031/api/v1",
        serviceBaseUrl: "http://127.0.0.1:4031",
        fetch: fetchImplementation,
        maxRetries,
        sleep: () => Promise.resolve(),
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    }),
    { legacy: "stateless", responseMode: "auto" },
  );
  const client = new Client(
    { name: "spicy-devkit-asset-test", version: "1.0.0" },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      inputRequired: { autoFulfill: true, maxRounds: 3 },
    },
  );
  client.setRequestHandler("elicitation/create", (request) => {
    if (request.params.mode === "form") messages.push(request.params.message);
    return confirmation === "accept"
      ? { action: "accept", content: { confirm: true } }
      : { action: "decline" };
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://spicy-mcp.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

void test("the asset tools are registered with honest annotations and explain spicy://a/", async () => {
  for (const name of ASSET_TOOLS) {
    assert.ok((SPICYAPI_MCP_TOOLS as readonly string[]).includes(name), `${name} is missing`);
  }
  const connection = await connect(recorder([]).fetch);
  try {
    const { tools } = await connection.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("spicyapi_assets_list")?.annotations?.readOnlyHint, true);
    assert.equal(byName.get("spicyapi_assets_usage_get")?.annotations?.readOnlyHint, true);
    assert.equal(byName.get("spicyapi_asset_save")?.annotations?.readOnlyHint, false);
    assert.equal(byName.get("spicyapi_asset_delete")?.annotations?.destructiveHint, true);
    assert.equal(byName.get("spicyapi_asset_rename")?.annotations?.destructiveHint, false);
    assert.match(byName.get("spicyapi_assets_list")?.description ?? "", /spicy:\/\/a\/<id>/);
    assert.match(byName.get("spicyapi_asset_save")?.description ?? "", /exactly one source/);
    assert.match(byName.get("spicyapi_asset_delete")?.description ?? "", /no undo/);
    for (const name of ["spicyapi_characters_list", "spicyapi_character_get"]) {
      const tool = byName.get(name);
      assert.equal(tool?.annotations?.readOnlyHint, true, `${name} must be read-only`);
      assert.equal(tool?.annotations?.destructiveHint, false);
      assert.match(tool?.description ?? "", /in the order given, into the reference image field/);
      assert.match(tool?.description ?? "", /spicy:\/\/p\/<id>/);
    }
  } finally {
    await connection.close();
  }
});

void test("assets_list maps its filters onto the API and returns the page", async () => {
  const api = recorder([
    envelope({ items: [asset("ast_1"), asset("ast_doc", { kind: "document" })], nextCursor: "c2" }),
  ]);
  const connection = await connect(api.fetch);
  try {
    const result = await connection.client.callTool({
      name: "spicyapi_assets_list",
      arguments: { kind: "image", source: ["task_output", "upload"], query: "hero", cursor: "c1" },
    });
    // An unknown kind must not fail the output schema: the set of kinds is open.
    assert.equal(result.isError, undefined, text(result));
    const url = api.calls[0]?.url;
    assert.equal(url?.pathname, "/api/v1/assets");
    assert.equal(url?.searchParams.get("kind"), "image");
    assert.equal(url?.searchParams.get("source"), "task_output,upload");
    assert.equal(url?.searchParams.get("q"), "hero");
    assert.equal(url?.searchParams.get("cursor"), "c1");
    assert.equal(url?.searchParams.get("limit"), "20", "a short default page keeps context small");
    const page = (result.structuredContent as { result: { items: Array<{ uri: string }> } }).result;
    assert.deepEqual(
      page.items.map((item) => item.uri),
      ["spicy://a/ast_1", "spicy://a/ast_doc"],
    );
  } finally {
    await connection.close();
  }
});

void test("asset_save from a task output defaults to the first output and adds a key", async () => {
  const api = recorder([envelope(asset("ast_1")), envelope(asset("ast_2"))]);
  const connection = await connect(api.fetch);
  try {
    const first = await connection.client.callTool({
      name: "spicyapi_asset_save",
      arguments: { taskId: "job_1", name: "Hero" },
    });
    const second = await connection.client.callTool({
      name: "spicyapi_asset_save",
      arguments: { taskId: "job_1", key: "out/2.png", idempotencyKey: "replay-me" },
    });
    assert.equal(first.isError, undefined, text(first));
    assert.equal(second.isError, undefined, text(second));
    assert.equal(api.calls[0]?.method, "POST");
    assert.deepEqual(api.calls[0]?.body, {
      source: "task_output",
      taskId: "job_1",
      index: 0,
      name: "Hero",
    });
    assert.match(api.calls[0]?.headers.get("idempotency-key") ?? "", UUID);
    assert.deepEqual(api.calls[1]?.body, {
      source: "task_output",
      taskId: "job_1",
      key: "out/2.png",
    });
    assert.equal(api.calls[1]?.headers.get("idempotency-key"), "replay-me");
    assert.match(text(first), /spicy:\/\/a\/ast_1/);
  } finally {
    await connection.close();
  }
});

void test("asset_save refuses an ambiguous source before calling the API", async () => {
  const api = recorder([]);
  const connection = await connect(api.fetch);
  try {
    for (const args of [
      {},
      { taskId: "job_1", url: "https://cdn.example/a.png" },
      { url: "https://cdn.example/a.png", index: 1 },
      { taskId: "job_1", index: 0, key: "a.png" },
      { fileId: "fil_1", contentType: "image/png" },
    ]) {
      const result = await connection.client.callTool({
        name: "spicyapi_asset_save",
        arguments: args,
      });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(api.calls.length, 0);
  } finally {
    await connection.close();
  }
});

void test("asset_save from a local path uploads inside the allowed roots and saves the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-mcp-assets-"));
  const filePath = join(directory, "logo.png");
  await writeFile(filePath, "png-bytes");
  process.env.SPICY_MCP_UPLOAD_ROOTS = directory;
  const api = recorder([
    envelope({
      fileId: "fil_8",
      key: "pending",
      uploadUrl: "https://storage.example/upload/fil_8",
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      expiresAt: "2026-10-12T00:10:00Z",
      maxBytes: 10_485_760,
    }),
    new Response(null, { status: 204 }),
    envelope({
      fileId: "fil_8",
      status: "ready",
      bytes: 9,
      contentType: "image/png",
      sha256: "d".repeat(64),
      uri: "spicy://f/fil_8",
      expiresAt: "2026-10-13T00:00:00Z",
    }),
    envelope(asset("ast_logo", { source: "upload", name: "logo.png" })),
  ]);
  const connection = await connect(api.fetch);
  try {
    const saved = await connection.client.callTool({
      name: "spicyapi_asset_save",
      arguments: { path: filePath },
    });
    assert.equal(saved.isError, undefined, text(saved));
    assert.deepEqual(api.calls[3]?.body, { source: "upload", fileId: "fil_8", name: "logo.png" });
    // The upload ticket must never reach the model's context.
    assert.equal(text(saved).includes("storage.example"), false);

    const outside = await connection.client.callTool({
      name: "spicyapi_asset_save",
      arguments: { path: join(tmpdir(), "definitely-not-allowed.png") },
    });
    assert.equal(outside.isError, true);
    assert.equal(api.calls.length, 4, "a refused path must not start an upload");
  } finally {
    await connection.close();
    delete process.env.SPICY_MCP_UPLOAD_ROOTS;
    await rm(directory, { recursive: true, force: true });
  }
});

void test("asset_delete sends nothing when declined and deletes after confirmation", async () => {
  const declinedApi = recorder([]);
  const messages: string[] = [];
  const declined = await connect(declinedApi.fetch, "decline", messages);
  try {
    const result = await declined.client.callTool({
      name: "spicyapi_asset_delete",
      arguments: { assetId: "spicy://a/ast_1" },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /the asset was not deleted/);
    assert.equal(declinedApi.calls.length, 0);
    assert.match(messages[0] ?? "", /not reversible/);
    assert.equal(messages[0]?.includes("Idempotency-Key"), false);
  } finally {
    await declined.close();
  }

  const acceptedApi = recorder([envelope({ id: "ast_1", deleted: true })]);
  const accepted = await connect(acceptedApi.fetch);
  try {
    const result = await accepted.client.callTool({
      name: "spicyapi_asset_delete",
      arguments: { assetId: "spicy://a/ast_1" },
    });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(acceptedApi.calls[0]?.method, "DELETE");
    assert.equal(acceptedApi.calls[0]?.url.pathname, "/api/v1/assets/ast_1");
    assert.deepEqual(result.structuredContent, { result: { id: "ast_1", deleted: true } });
  } finally {
    await accepted.close();
  }
});

void test("asset_rename and assets_usage_get reach their routes", async () => {
  const plan = {
    id: "free",
    name: "Free",
    minTopupUsd: "0",
    maxBytes: 0,
    maxCount: 0,
    maxFileBytes: 0,
  };
  const api = recorder([
    envelope(asset("ast_1", { name: "Hero v2" })),
    envelope({
      tier: plan,
      usage: { count: 0, bytes: 0 },
      limits: {
        tier: "free",
        maxCount: 0,
        maxBytes: 0,
        maxFileBytes: 0,
        globalMaxBytes: 0,
        nameMaxChars: 80,
      },
      full: true,
      nextTier: { ...plan, id: "plus", name: "Plus", minTopupUsd: "10", maxBytes: 524288000 },
      tiers: [plan],
      dailyCreateLimit: 200,
      createdToday: 0,
      scope: {
        workspaceId: "ws_team",
        personal: false,
        role: "billing",
        canWrite: false,
        canTopUp: false,
      },
    }),
  ]);
  const connection = await connect(api.fetch);
  try {
    const renamed = await connection.client.callTool({
      name: "spicyapi_asset_rename",
      arguments: { assetId: "ast_1", name: "Hero v2" },
    });
    const usage = await connection.client.callTool({
      name: "spicyapi_assets_usage_get",
      arguments: {},
    });
    assert.equal(renamed.isError, undefined, text(renamed));
    assert.equal(usage.isError, undefined, text(usage));
    assert.deepEqual(
      api.calls.map((call) => `${call.method} ${call.url.pathname}`),
      ["PATCH /api/v1/assets/ast_1", "GET /api/v1/assets/usage"],
    );
    assert.deepEqual(api.calls[0]?.body, { name: "Hero v2" });
    const result = (
      usage.structuredContent as {
        result: {
          full: boolean;
          nextTier: { name: string };
          scope: { personal: boolean; canTopUp: boolean };
          lifetimeTopupUsd?: string;
        };
      }
    ).result;
    assert.equal(result.full, true);
    assert.equal(result.nextTier.name, "Plus");
    assert.equal(result.scope.personal, false);
    assert.equal(result.scope.canTopUp, false);
    // A team key without top-up rights gets no amounts, and the schema must accept their absence.
    assert.equal(result.lifetimeTopupUsd, undefined);
  } finally {
    await connection.close();
  }
});

void test("a refusal reaches the model with its reason, and a 403 is not retried", async () => {
  const api = recorder([
    failure(400, "asset_library_locked"),
    failure(403, "asset_workspace_forbidden"),
    failure(403),
  ]);
  const connection = await connect(api.fetch, "accept", [], 2);
  try {
    const locked = await connection.client.callTool({
      name: "spicyapi_asset_save",
      arguments: { url: "https://cdn.example/a.png" },
    });
    assert.equal(locked.isError, true);
    const lockedDetails = JSON.parse(text(locked)) as { status: number; reason: string };
    assert.equal(lockedDetails.status, 400);
    assert.equal(lockedDetails.reason, "asset_library_locked");

    const forbidden = await connection.client.callTool({
      name: "spicyapi_assets_list",
      arguments: {},
    });
    const forbiddenDetails = JSON.parse(text(forbidden)) as {
      status: number;
      code: number;
      reason: string;
      requestId: string;
    };
    assert.deepEqual(forbiddenDetails, {
      error: "refused by the asset library",
      type: "SpicyApiError",
      status: 403,
      code: 403,
      reason: "asset_workspace_forbidden",
      requestId: "req_mcp_fail",
    });

    const bare = await connection.client.callTool({
      name: "spicyapi_assets_usage_get",
      arguments: {},
    });
    const bareDetails = JSON.parse(text(bare)) as Record<string, unknown>;
    assert.equal(bareDetails.status, 403);
    assert.equal("reason" in bareDetails, false, "no reason is invented when the server sent none");
    assert.equal(api.calls.length, 3, "each 403 was sent once even with retries enabled");
  } finally {
    await connection.close();
  }
});

void test("assets_list sends favorite, folder, character and sort filters", async () => {
  const api = recorder([
    envelope({ items: [asset("ast_1", { favorite: true })] }),
    envelope({ items: [] }),
  ]);
  const connection = await connect(api.fetch);
  try {
    const result = await connection.client.callTool({
      name: "spicyapi_assets_list",
      arguments: {
        favorite: true,
        collectionId: "col_moodboard",
        entityId: "ety_mia",
        sort: "size",
      },
    });
    assert.equal(result.isError, undefined, text(result));
    const query = api.calls[0]?.url.searchParams;
    assert.equal(query?.get("favorite"), "true");
    assert.equal(query?.get("collectionId"), "col_moodboard");
    assert.equal(query?.get("entityId"), "ety_mia");
    assert.equal(query?.get("sort"), "size");
    const page = (result.structuredContent as { result: { items: Array<{ favorite: boolean }> } })
      .result;
    assert.equal(page.items[0]?.favorite, true);

    // Counter-proof: favorite false is its own filter and must reach the API.
    await connection.client.callTool({
      name: "spicyapi_assets_list",
      arguments: { favorite: false },
    });
    assert.equal(api.calls[1]?.url.searchParams.get("favorite"), "false");
    assert.equal(api.calls[1]?.url.searchParams.has("sort"), false);
  } finally {
    await connection.close();
  }
});

void test("assets_list refuses an unknown sort locally and passes a stale cursor's 400 through", async () => {
  const api = recorder([failure(400)]);
  const connection = await connect(api.fetch, "accept", [], 2);
  try {
    const invalid = await connection.client.callTool({
      name: "spicyapi_assets_list",
      arguments: { sort: "biggest" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(api.calls.length, 0, "an unknown sort must not reach the API");

    const stale = await connection.client.callTool({
      name: "spicyapi_assets_list",
      arguments: { sort: "oldest", cursor: "name-c2" },
    });
    assert.equal(stale.isError, true);
    const details = JSON.parse(text(stale)) as { status: number; requestId: string };
    assert.equal(details.status, 400);
    assert.equal(details.requestId, "req_mcp_fail");
    assert.equal(api.calls.length, 1, "a rejected cursor is not retried");
    assert.equal(api.calls[0]?.url.searchParams.get("cursor"), "name-c2");
  } finally {
    await connection.close();
  }
});

void test("characters_list and character_get read characters with their images in order", async () => {
  const api = recorder([
    envelope({ items: [character("ety_mia", ["ast_front", "ast_side"])], nextCursor: "ec2" }),
    envelope(character("ety_mia", ["ast_front", "ast_side"])),
  ]);
  const connection = await connect(api.fetch);
  try {
    const listed = await connection.client.callTool({
      name: "spicyapi_characters_list",
      arguments: { assetId: "spicy://a/ast_front" },
    });
    assert.equal(listed.isError, undefined, text(listed));
    assert.equal(api.calls[0]?.url.pathname, "/api/v1/assets/entities");
    assert.equal(api.calls[0]?.url.searchParams.get("assetId"), "ast_front");
    assert.equal(api.calls[0]?.url.searchParams.get("limit"), "20");

    const one = await connection.client.callTool({
      name: "spicyapi_character_get",
      arguments: { characterId: "ety_mia" },
    });
    assert.equal(one.isError, undefined, text(one));
    assert.equal(api.calls[1]?.url.pathname, "/api/v1/assets/entities/ety_mia");
    const character = (one.structuredContent as { result: { assets: Array<{ uri: string }> } })
      .result;
    assert.deepEqual(
      character.assets.map((image) => image.uri),
      ["spicy://a/ast_front", "spicy://a/ast_side"],
    );
  } finally {
    await connection.close();
  }
});

void test("an unknown character is a 404 reported to the model and not retried", async () => {
  const api = recorder([failure(404)]);
  const connection = await connect(api.fetch, "accept", [], 2);
  try {
    const missing = await connection.client.callTool({
      name: "spicyapi_character_get",
      arguments: { characterId: "ety_gone" },
    });
    assert.equal(missing.isError, true);
    const details = JSON.parse(text(missing)) as { status: number; code: number };
    assert.equal(details.status, 404);
    assert.equal(details.code, 404);
    assert.equal(api.calls.length, 1);
  } finally {
    await connection.close();
  }
});
