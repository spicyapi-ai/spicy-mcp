import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { SpicyClient } from "@spicyapi/sdk";

import {
  createSpicyMcpFactory,
  SPICYAPI_MCP_TOOLS,
  type SpicyMcpFactoryOptions,
} from "../src/mcp/server.js";

interface ConnectedMcp {
  client: Client;
  close: () => Promise<void>;
}

async function connectMcp(
  options: SpicyMcpFactoryOptions,
  confirmation: "accept" | "decline" = "accept",
  messages: string[] = [],
): Promise<ConnectedMcp> {
  const handler = createMcpHandler(createSpicyMcpFactory(options), {
    legacy: "stateless",
    responseMode: "auto",
  });
  const clientTransport = new StreamableHTTPClientTransport(new URL("http://spicy-mcp.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "spicy-devkit-test", version: "1.0.0" },
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
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

function apiClient(fetchImplementation: typeof fetch): SpicyClient {
  return new SpicyClient({
    apiKey: "sk_mcp_secret",
    apiBaseUrl: "http://127.0.0.1:4030/api/v1",
    serviceBaseUrl: "http://127.0.0.1:4030",
    fetch: fetchImplementation,
    maxRetries: 0,
  });
}

void test("modern MCP discovery exposes the complete focused surface", async () => {
  const fetchImplementation: typeof fetch = () =>
    Promise.resolve(
      Response.json({ code: 500, msg: "unused", request_id: "req_unused" }, { status: 500 }),
    );
  const connection = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const tools = await connection.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...SPICYAPI_MCP_TOOLS].sort());
    const createTool = tools.tools.find((tool) => tool.name === "spicyapi_task_create");
    assert.equal(createTool?.annotations?.readOnlyHint, false);
    assert.equal(createTool?.annotations?.idempotentHint, true);
    const matureInput = (
      createTool?.inputSchema as
        | {
            properties?: { mature?: { description?: string } };
          }
        | undefined
    )?.properties?.mature;
    assert.equal(matureInput, undefined);
    for (const tool of tools.tools) {
      const output = tool.outputSchema as {
        properties?: { result?: Record<string, unknown> };
      };
      const result = output.properties?.result;
      assert.ok(result, `${tool.name} must describe structuredContent.result`);
      assert.ok(
        Object.keys(result).length > 0,
        `${tool.name} must expose a concrete result schema`,
      );
    }

    const resources = await connection.client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
      "spicyapi://contract/openapi",
      "spicyapi://docs/index",
    ]);
    const contract = await connection.client.readResource({ uri: "spicyapi://contract/openapi" });
    const contractContent = contract.contents[0];
    assert.ok(contractContent && "text" in contractContent);
    assert.match(contractContent.text, /^openapi: 3\.1\.0/m);

    const prompts = await connection.client.listPrompts();
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.name),
      ["spicyapi_generation_workflow"],
    );
    const prompt = await connection.client.getPrompt({
      name: "spicyapi_generation_workflow",
      arguments: { goal: "create an image" },
    });
    const firstContent = prompt.messages[0]?.content;
    assert.equal(firstContent?.type, "text");
    if (firstContent?.type === "text") assert.match(firstContent.text, /Do not invent fields/);
  } finally {
    await connection.close();
  }
});

void test("a 404 from /readyz on the public surface is not reported as a fault, and whoever reads it can tell why", async () => {
  // A colleague reviewing this read the 404 as "the readiness endpoint needs fixing" and suggested
  // implementing /readyz to answer 200 on the public surface - which would expose the state of the
  // database and Redis to the internet, the very reason the server deliberately does not register
  // it. The logic here was always right (operational already treats a 404 as "no such probe here");
  // what was missing is that the conclusion lived only in a source comment, and MCP consumers do
  // not read source. So `readiness.ok: false` and `operational: true` sat side by side in the
  // structure, looking self-contradictory.
  //
  // This test therefore pins two things: that the conclusion is right, and that the reason for it
  // travels with the output.
  const fetchImplementation: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/healthz")) {
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    }
    if (url.endsWith("/readyz")) {
      return Promise.resolve(new Response("404 page not found", { status: 404 }));
    }
    return Promise.reject(new Error(`unexpected probe: ${url}`));
  };

  const connection = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const tools = await connection.client.listTools();
    const statusTool = tools.tools.find((tool) => tool.name === "spicyapi_service_status");
    assert.ok(statusTool, "spicyapi_service_status is missing");

    // 1. The tool description has to say the 404 is by design, or readers report it as an incident.
    assert.match(
      statusTool.description ?? "",
      /404/,
      "the tool description never mentions the /readyz 404, leaving consumers to guess",
    );
    assert.match(statusTool.description ?? "", /operational/, "the tool description does not say which field to report");

    // 2. The output schema has to carry the explanation too - descriptions travel to the model with
    //    the schema.
    const schemaText = JSON.stringify(statusTool.outputSchema ?? {});
    assert.match(schemaText, /admin process/, "the outputSchema does not explain where the 404 comes from");
    assert.match(schemaText, /503/, "the outputSchema does not say what genuine unreadiness looks like");

    // 3. The conclusion itself: a 404 must not make operational false.
    const result = await connection.client.callTool({
      name: "spicyapi_service_status",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      result?: { operational?: boolean; readiness?: { status?: number } };
    };
    assert.equal(structured.result?.readiness?.status, 404);
    assert.equal(
      structured.result?.operational,
      true,
      "the public surface does not offer /readyz by design, and treating its 404 as a fault would make operational permanently false",
    );
  } finally {
    await connection.close();
  }
});

void test("read-only docs tool returns structured first-party results", async () => {
  const connection = await connectMcp({
    client: apiClient(() => Promise.reject(new Error("API must not be called"))),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    await connection.client.listTools();
    const result = await connection.client.callTool({
      name: "spicyapi_docs_search",
      arguments: { query: "idempotency", limit: 3 },
    });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent !== undefined);
    const structured = result.structuredContent as {
      result?: Array<{ slug: string; url: string }>;
    };
    assert.equal(structured.result?.[0]?.slug, "idempotency");
    assert.equal(structured.result?.[0]?.url, "https://docs.spicyapi.ai/docs/idempotency");

    const naturalLanguageCases = [
      ["avoid duplicate holds across keys", "idempotency"],
      ["raw body callback signing", "webhooks"],
      ["no route effective customer price unavailable", "errors"],
      ["model capabilities no content review", "policy"],
    ] as const;
    for (const [query, expectedSlug] of naturalLanguageCases) {
      const naturalResult = await connection.client.callTool({
        name: "spicyapi_docs_search",
        arguments: { query, limit: 3 },
      });
      const naturalStructured = naturalResult.structuredContent as {
        result?: Array<{ slug: string }>;
      };
      assert.equal(naturalStructured.result?.[0]?.slug, expectedSlug, query);
    }
  } finally {
    await connection.close();
  }
});

void test("usage tool preserves key scope, UTC filters and exact settled USD without prechecks", async () => {
  const paths: string[] = [];
  const messages: string[] = [];
  const report = {
    from: "2026-08-31",
    to: "2026-09-07",
    currency: "USD",
    totalCalls: 3,
    totalSpend: "0.123456789",
    days: [{ day: "2026-09-01", calls: 3, succeeded: 1, failed: 1, spend: "0.123456789" }],
    models: [
      { model: "example/model/edit", calls: 3, succeeded: 1, failed: 1, spend: "0.123456789" },
    ],
  };
  const connection = await connectMcp(
    {
      client: apiClient((input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        paths.push(url.pathname + url.search);
        assert.equal(init?.method, "GET");
        assert.equal(url.pathname, "/api/v1/usage");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_mcp_secret");
        assert.equal(init?.body, undefined);
        if (url.searchParams.get("from") === "2026-01-01") {
          return Promise.resolve(
            Response.json(
              {
                code: 400,
                msg: "Date range must not exceed 92 days",
                request_id: "req_usage_range",
              },
              { status: 400 },
            ),
          );
        }
        return Promise.resolve(
          Response.json({ code: 200, msg: "success", request_id: "req_usage", data: report }),
        );
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    },
    "decline",
    messages,
  );
  try {
    const tools = await connection.client.listTools();
    const tool = tools.tools.find((item) => item.name === "spicyapi_usage_get");
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const schema = tool?.inputSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["from", "to"]);
    assert.equal(schema.additionalProperties, false);
    assert.match(tool?.description ?? "", /current API key/);
    assert.match(tool?.description ?? "", /UTC \[from,to\)/);
    assert.match(tool?.description ?? "", /settled actual USD/);
    assert.match(tool?.description ?? "", /not a generation prerequisite/);

    for (const args of [{}, { from: "2026-08-31", to: "2026-09-07" }]) {
      const result = await connection.client.callTool({
        name: "spicyapi_usage_get",
        arguments: args,
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { result: report });
      const content = result.content[0];
      assert.ok(content?.type === "text");
      assert.deepEqual(JSON.parse(content.text), report);
    }
    assert.deepEqual(paths, ["/api/v1/usage", "/api/v1/usage?from=2026-08-31&to=2026-09-07"]);
    assert.deepEqual(messages, [], "a read-only usage query must not trigger a spending confirmation");

    for (const args of [
      { userId: "other-user" },
      { keyId: "other-key" },
      { workspaceId: "other-workspace" },
      { from: "2026-02-30" },
      { to: "2026-09-07T00:00:00Z" },
    ]) {
      const rejected = await connection.client.callTool({
        name: "spicyapi_usage_get",
        arguments: args,
      });
      assert.equal(rejected.isError, true);
    }
    assert.equal(paths.length, 2, "an identity override or an invalid date must not trigger an API request");

    const rangeError = await connection.client.callTool({
      name: "spicyapi_usage_get",
      arguments: { from: "2026-01-01", to: "2026-09-07" },
    });
    assert.equal(rangeError.isError, true);
    const errorContent = rangeError.content[0];
    assert.ok(errorContent?.type === "text");
    assert.match(errorContent.text, /req_usage_range/);
    assert.match(errorContent.text, /92 days/);
    assert.equal(paths.length, 3, "the server rules on the date range; it is neither split nor widened automatically");
  } finally {
    await connection.close();
  }
});

void test("MCP waiting uses SDK backoff by default and preserves an explicit fixed interval", async () => {
  for (const intervalSeconds of [undefined, 7]) {
    let now = 0;
    let requests = 0;
    const delays: number[] = [];
    const connection = await connectMcp({
      client: new SpicyClient({
        apiKey: "sk_wait_test",
        apiBaseUrl: "http://127.0.0.1:4030/api/v1",
        maxRetries: 0,
        now: () => now,
        random: () => 0,
        sleep: (milliseconds) => {
          delays.push(milliseconds);
          now += milliseconds;
          return Promise.resolve();
        },
        fetch: (input) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          assert.equal(url.pathname, "/api/v1/jobs/recordInfo");
          assert.equal(url.searchParams.get("taskId"), "job_wait");
          requests++;
          return Promise.resolve(
            Response.json({
              code: 200,
              msg: "success",
              request_id: "req_wait",
              data: {
                taskId: "job_wait",
                model: "example/model/edit",
                state: requests === 7 ? "succeeded" : "running",
                cost: "0",
                settled: requests === 7,
                createdAt: "2026-09-06T00:00:00Z",
              },
            }),
          );
        },
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    });
    try {
      // Verified through real MCP argument parsing and real SDK polling, with a virtual clock so
      // nothing actually waits.
      const result = await connection.client.callTool({
        name: "spicyapi_task_wait",
        arguments: {
          taskId: "job_wait",
          ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
        },
      });
      assert.equal(result.isError, undefined);
      assert.equal(requests, 7);
      assert.deepEqual(
        delays,
        intervalSeconds === undefined
          ? [2000, 3000, 4500, 6750, 10000, 10000]
          : Array<number>(6).fill(7000),
      );
    } finally {
      await connection.close();
    }
  }
});

void test("accepted billable MRTR executes once with the server-minted idempotency key", async () => {
  let calls = 0;
  let quoteCalls = 0;
  let idempotencyKey = "";
  let requestBody = "";
  const fetchImplementation: typeof fetch = (_input, init) => {
    if (
      (typeof _input === "string"
        ? _input
        : _input instanceof URL
          ? _input.href
          : _input.url
      ).endsWith("/jobs/quote")
    ) {
      quoteCalls += 1;
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_quote",
          data: {
            quoteId: "quote_mcp",
            model: "provider/model",
            estimatedCost: "0.20",
            maxCharge: "0.25",
            currency: "USD",
            quantity: "1",
            unit: "per_request",
            expiresAt: "2026-09-05T12:05:00Z",
          },
        }),
      );
    }
    calls += 1;
    idempotencyKey = new Headers(init?.headers).get("idempotency-key") ?? "";
    requestBody = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(
      Response.json({
        code: 200,
        msg: "success",
        request_id: "req_mcp_create",
        data: { taskId: "job_mcp", state: "queued", estimatedCost: "0.20" },
      }),
    );
  };
  const messages: string[] = [];
  const connection = await connectMcp(
    {
      client: apiClient(fetchImplementation),
      stateSecret: "0123456789abcdef0123456789abcdef",
    },
    "accept",
    messages,
  );
  try {
    await connection.client.listTools();
    const result = await connection.client.callTool({
      name: "spicyapi_task_create",
      arguments: {
        model: "provider/model",
        input: { prompt: "hello", futureField: true },
      },
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls, 1);
    // A direct creation takes exactly one quote; confirming recovery must neither re-quote nor
    // insert a diagnostic request.
    assert.equal(quoteCalls, 1);
    assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
    const parsedRequest = JSON.parse(requestBody) as { mature?: unknown };
    assert.equal(parsedRequest.mature, undefined);
    assert.equal((JSON.parse(requestBody) as { quoteId: string }).quoteId, "quote_mcp");
    assert.equal((JSON.parse(requestBody) as { expectedCost: string }).expectedCost, "0.20");
    assert.match(messages[0] ?? "", /maximum charge: USD 0.25/);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", new RegExp(idempotencyKey));
    assert.equal((messages[0] ?? "").includes("mature"), false);
    const structured = result.structuredContent as {
      result?: { idempotencyKey?: string; taskId?: string };
    };
    assert.equal(structured.result?.idempotencyKey, idempotencyKey);
    assert.equal(structured.result?.taskId, "job_mcp");
  } finally {
    await connection.close();
  }
});

void test("a confirmed retry really goes out, carrying the idempotency key and the source task", async () => {
  // A colleague reviewing this pointed out that task_retry had only ever been exercised down the
  // "declined" path, because there was no failed or expired task in production to retry at the time,
  // so the success path had never run. The gap was real: the declined path proves "nothing is spent
  // without confirmation" and says not one word about what the request after confirmation looks
  // like.
  //
  // This test supplies the other half, pinning four things: that the request goes out, that it goes
  // to /jobs/retry, that the body carries the SOURCE task id, and that the idempotency key both
  // genuinely reaches the request headers and comes back to the caller unchanged (without which the
  // caller has nothing to reuse on a timeout resend, and one unknown outcome becomes a second
  // billable task).
  const requests: Array<{ url: string; body: string; idempotencyKey: string | null }> = [];
  const fetchImplementation: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
    });
    return Promise.resolve(
      Response.json({
        code: 200,
        msg: "success",
        request_id: "req_retry",
        data: {
          taskId: "job_retried",
          state: "queued",
          estimatedCost: "0.42",
          sourceTaskId: "job_failed",
        },
      }),
    );
  };

  const connection = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    await connection.client.listTools();
    const result = await connection.client.callTool({
      name: "spicyapi_task_retry",
      arguments: { taskId: "job_failed" },
    });

    assert.equal(result.isError, undefined, "the retry still failed after confirmation");
    assert.equal(requests.length, 1, "exactly one request should go out after confirmation");
    const sent = requests[0];
    assert.ok(sent?.url.endsWith("/jobs/retry"), String(sent?.url));
    assert.match(sent?.body ?? "", /job_failed/, "the request body carries no source task id");
    assert.ok(sent?.idempotencyKey, "the retry carried no Idempotency-Key - a timeout resend would become a second billable task");

    const structured = result.structuredContent as {
      result?: {
        taskId?: string;
        sourceTaskId?: string;
        estimatedCost?: string;
        idempotencyKey?: string;
      };
    };
    assert.equal(structured.result?.taskId, "job_retried");
    assert.equal(structured.result?.sourceTaskId, "job_failed", "the new task does not point back at the one it retried");
    assert.equal(structured.result?.estimatedCost, "0.42");
    assert.equal(
      structured.result?.idempotencyKey,
      sent?.idempotencyKey,
      "the key returned to the caller has to be the one that was sent, or a resend reuses a different one",
    );
  } finally {
    await connection.close();
  }
});

void test("declined billable MRTR never calls SpicyAPI", async () => {
  let calls = 0;
  const connection = await connectMcp(
    {
      client: apiClient(() => {
        calls += 1;
        return Promise.resolve(Response.json({ code: 500, msg: "unexpected", request_id: "req" }));
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    },
    "decline",
  );
  try {
    await connection.client.listTools();
    const result = await connection.client.callTool({
      name: "spicyapi_task_retry",
      arguments: { taskId: "job_failed" },
    });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /declined/);
    // A retry genuinely sends nothing before confirmation, so that sentence holds for it.
    assert.match(text, /no SpicyAPI request was made/);
  } finally {
    await connection.close();
  }
});

void test("model schemas reach the agent as plain JSON Schema without display or rate-card keys", async () => {
  // The public schema the server sends carries x-ui and x-pricing; the MCP side has to strip them
  // before returning, including those nested under items.properties.
  const catalogItem = {
    model: "family/version/task",
    family: "family",
    familyPageSlug: "family-page",
    familyDisplayName: "Family",
    displayName: "Family Endpoint",
    provider: "Model Creator",
    modality: "video",
    tasks: ["text-to-video"],
    async: true,
    mature: false,
    policyTier: "unspecified",
    taskTimeoutSeconds: 900,
    enabled: true,
    available: true,
    quantityField: "duration_seconds",
    pricing: [{ variant: "", unit: "per_second", price: "0.10", currency: "USD" }],
    version: "1",
    availability: "available",
    badges: [],
    relatedModels: [],
    updatedAt: "2026-09-04T00:00:00Z",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      "x-pricing": { variantFields: ["resolution"], billingMode: "variant_matrix" },
      "x-order-properties": ["prompt"],
      required: ["prompt"],
      properties: {
        prompt: { type: "string", "x-ui": { widget: "textarea", order: 990 } },
        adapters: {
          type: "array",
          "x-ui": { widget: "object-list", order: 980 },
          items: {
            type: "object",
            properties: { path: { type: "string", "x-ui": { widget: "select" } } },
          },
        },
      },
    },
  };
  const fetchImplementation: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const data = url.includes("/models?")
      ? { total: 1, items: [catalogItem] }
      : (catalogItem as unknown);
    return Promise.resolve(Response.json({ code: 200, msg: "success", request_id: "req", data }));
  };
  const connection = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const tools = await connection.client.listTools();
    for (const name of ["spicyapi_models_list", "spicyapi_model_get"]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.match(tool?.description ?? "", /plain JSON Schema/);
      assert.match(tool?.description ?? "", /change the price/);
    }

    const listed = await connection.client.callTool({
      name: "spicyapi_models_list",
      arguments: { includeSchema: true },
    });
    const listedText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
    for (const key of ["x-ui", "x-pricing", "x-order-properties", "billingMode", "variantFields"]) {
      assert.equal(listedText.includes(key), false, `${key} must not reach the agent`);
    }
    assert.ok(listedText.includes("textarea") === false);
    assert.ok(listedText.includes("additionalProperties"));

    const single = await connection.client.callTool({
      name: "spicyapi_model_get",
      arguments: { model: "family/version/task" },
    });
    const schema = (
      single.structuredContent as {
        result?: {
          inputSchema?: {
            required?: string[];
            properties?: Record<string, Record<string, unknown>>;
          };
        };
      }
    ).result?.inputSchema;
    assert.deepEqual(schema?.required, ["prompt"]);
    assert.equal(schema?.properties?.prompt?.type, "string");
    assert.equal("x-ui" in (schema?.properties?.prompt ?? {}), false);
    const nested = schema?.properties?.adapters?.items as {
      properties?: Record<string, Record<string, unknown>>;
    };
    assert.equal("x-ui" in (nested.properties?.path ?? {}), false);
    assert.equal(nested.properties?.path?.type, "string");
  } finally {
    await connection.close();
  }
});

void test("every live content-policy tier survives the output schema instead of failing the call", async () => {
  // This field's outputSchema once hard-coded three values (unrestricted, borderline, unspecified)
  // while the server already had five. Measured against production on 2026-09-20: 16 of the 121
  // endpoints were softened or filtered, so any unfiltered models_list threw an Output validation
  // error - a structuredContent validation failure in the MCP SDK is a hard failure, not a warning.
  //
  // It went undetected because the fixture above used `unspecified`, a value that has never once
  // appeared in production. So this test runs every real tier plus one nobody has seen: the day the
  // server adds a sixth, it must still work.
  const tiers = [
    "unrestricted",
    "borderline",
    "softened",
    "filtered",
    "unspecified",
    "tier-we-have-not-shipped-yet",
  ];
  const items = tiers.map((policyTier, index) => ({
    model: `family/version-${index}/text-to-video`,
    family: `family-${index}`,
    familyPageSlug: `family-${index}`,
    familyDisplayName: "Family",
    displayName: `Endpoint ${index}`,
    provider: "Model Creator",
    modality: "video",
    tasks: ["text-to-video"],
    async: true,
    mature: false,
    policyTier,
    taskTimeoutSeconds: 900,
    enabled: true,
    available: true,
    quantityField: "duration_seconds",
    pricing: [{ variant: "", unit: "per_second", price: "0.10", currency: "USD" }],
    version: "1",
    availability: "available",
    badges: [],
    relatedModels: [],
    updatedAt: "2026-09-04T00:00:00Z",
  }));
  const fetchImplementation: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const data = url.includes("/models?") ? { total: items.length, items } : (items[0] as unknown);
    return Promise.resolve(Response.json({ code: 200, msg: "success", request_id: "req", data }));
  };
  const connection = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const listed = await connection.client.callTool({
      name: "spicyapi_models_list",
      arguments: {},
    });
    assert.equal(listed.isError, undefined, "a live policy tier must not fail the listing");
    const returned = (
      listed.structuredContent as { result?: { items?: Array<{ policyTier?: string }> } }
    ).result?.items;
    assert.deepEqual(
      returned?.map((item) => item.policyTier),
      tiers,
      "each tier must reach the agent unchanged",
    );
  } finally {
    await connection.close();
  }
});

void test("declining a quoted create never creates or reserves a task", async () => {
  const paths: string[] = [];
  const messages: string[] = [];
  const connection = await connectMcp(
    {
      client: apiClient((input) => {
        const path =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        paths.push(path);
        assert.ok(path.endsWith("/jobs/quote"));
        return Promise.resolve(
          Response.json({
            code: 200,
            msg: "success",
            request_id: "req_quote",
            data: {
              quoteId: "quote_declined",
              model: "family/version/task",
              estimatedCost: "0.12",
              maxCharge: "0.15",
              currency: "USD",
              quantity: "1",
              unit: "per_request",
              expiresAt: "2026-09-05T12:05:00Z",
            },
          }),
        );
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    },
    "decline",
    messages,
  );
  try {
    const result = await connection.client.callTool({
      name: "spicyapi_task_create",
      arguments: { model: "family/version/task", input: { prompt: "offline" } },
    });
    assert.equal(result.isError, true);
    assert.equal(paths.length, 1);
    assert.match(messages[0] ?? "", /Estimated charge: USD 0.12; maximum charge: USD 0.15/);
    // A quote has already gone out, so "no request was made" would be false of a creation; what to
    // say is that no task was created and no money moved.
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /declined/);
    assert.match(text, /no task was created/);
    assert.match(text, /quote/);
    assert.equal(text.includes("no SpicyAPI request was made"), false);
  } finally {
    await connection.close();
  }
});

void test("the task listing is scoped to the current key over the protocol, keeps paging and amounts, and fetches no detail automatically", async () => {
  const urls: URL[] = [];
  const messages: string[] = [];
  const page = {
    items: [
      {
        taskId: "task_1",
        model: "example/model/edit",
        state: "succeeded",
        cost: "0.000000001",
        settled: true,
        createdAt: "2026-09-01T00:00:00Z",
        deadlineAt: "2026-09-01T00:10:00Z",
      },
    ],
    hasMore: true,
    nextCursor: "opaque+/=",
  };
  const connection = await connectMcp(
    {
      client: apiClient((input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        urls.push(url);
        assert.equal(init?.method, "GET");
        assert.equal(url.pathname, "/api/v1/jobs");
        assert.equal(init?.body, undefined);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_mcp_secret");
        return Promise.resolve(
          Response.json({ code: 200, msg: "success", request_id: "req_tasks", data: page }),
        );
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    },
    "decline",
    messages,
  );
  try {
    const tool = (await connection.client.listTools()).tools.find(
      (item) => item.name === "spicyapi_tasks_list",
    );
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const schema = tool?.inputSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "cursor",
      "from",
      "limit",
      "model",
      "state",
      "to",
    ]);
    assert.equal(schema.additionalProperties, false);
    const args = {
      from: "2026-09-01",
      to: "2026-09-07",
      state: "succeeded",
      model: "example/model/edit",
      limit: 20,
      cursor: page.nextCursor,
    };
    for (const arguments_ of [{}, args]) {
      const result = await connection.client.callTool({
        name: "spicyapi_tasks_list",
        arguments: arguments_,
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { result: page });
      const content = result.content[0];
      assert.ok(content?.type === "text");
      assert.deepEqual(JSON.parse(content.text), page);
    }
    assert.equal(urls.length, 2);
    assert.equal(urls[0]?.search, "");
    assert.deepEqual(Object.fromEntries(urls[1]!.searchParams), { ...args, limit: "20" });
    assert.deepEqual(messages, []);
    for (const arguments_ of [
      { userId: "other" },
      { apiKeyId: "other" },
      { workspaceId: "other" },
      { limit: 101 },
      { state: "unknown" },
      { from: "2026-02-30" },
      { to: "2026-09-07T00:00:00Z" },
    ]) {
      const result = await connection.client.callTool({
        name: "spicyapi_tasks_list",
        arguments: arguments_,
      });
      assert.equal(result.isError, true);
    }
    assert.equal(urls.length, 2, "invalid arguments must not reach the API, and neither paging nor result reading happens automatically");
  } finally {
    await connection.close();
  }
});

void test("the purge tool is marked destructiveHint, sends nothing before confirmation, and returns no ticket or URL", async () => {
  const messages: string[] = [];
  const paths: string[] = [];
  /* The server answers with a response carrying extras: a signed URL, an output key and some raw
     upstream text. The tool has to project through an allow-list and keep four fields - writing a
     thread back to the content into the model's context at the moment of destruction means the
     purge deleted the object in the bucket and not the copy in the conversation. */
  const fetchImplementation: typeof fetch = (input) => {
    paths.push(new URL(String(input instanceof Request ? input.url : input)).pathname);
    return Promise.resolve(
      Response.json({
        code: 200,
        msg: "success",
        request_id: "req_purge",
        data: {
          taskId: "job_purge",
          contentState: "purged",
          purgedAt: "2026-09-13T10:00:00Z",
          contentRemovedBy: "user",
          billingRetained: true,
          downloadUrl: "https://example.r2.cloudflarestorage.com/out.png?X-Amz-Signature=deadbeef",
          outputKey: "results/2026/09/13/job_purge/out.png",
          upstreamMessage: "provider said ok",
        },
      }),
    );
  };

  const declined = await connectMcp(
    { client: apiClient(fetchImplementation), stateSecret: "0123456789abcdef0123456789abcdef" },
    "decline",
    messages,
  );
  try {
    const tools = await declined.client.listTools();
    const tool = tools.tools.find((item) => item.name === "spicyapi_task_purge");
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    assert.match(tool?.description ?? "", /cannot be undone/);
    assert.match(tool?.description ?? "", /not the record of what it cost/);
    assert.match(tool?.description ?? "", /never refunds/);
    // The public contract has no cancellation endpoint: the description must not send the model
    // looking for an action that does not exist.
    assert.equal(/cancell?ed first/i.test(tool?.description ?? ""), false);
    assert.match(tool?.description ?? "", /no cancellation API/);
    assert.match(tool?.description ?? "", /wait until it finishes/);

    const refused = await declined.client.callTool({
      name: "spicyapi_task_purge",
      arguments: { taskId: "job_purge" },
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(paths, [], "when the user declines, no request goes out at all");
    assert.match(
      refused.content[0]?.type === "text" ? refused.content[0].text : "",
      /nothing was destroyed/,
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /not reversible/);
    assert.match(messages[0] ?? "", /billing records are kept/i);
  } finally {
    await declined.close();
  }

  const accepted = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const result = await accepted.client.callTool({
      name: "spicyapi_task_purge",
      arguments: { taskId: "job_purge" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(paths, ["/api/v1/jobs/purge"]);
    assert.deepEqual(result.structuredContent, {
      result: {
        taskId: "job_purge",
        contentState: "purged",
        purgedAt: "2026-09-13T10:00:00Z",
        contentRemovedBy: "user",
        billingRetained: true,
      },
    });
    const content = result.content[0];
    assert.ok(content?.type === "text");
    for (const leak of [
      "downloadUrl",
      "X-Amz-Signature",
      "cloudflarestorage",
      "outputKey",
      "https://",
      "upstreamMessage",
    ]) {
      assert.equal(content.text.includes(leak), false, `destruction result must not carry ${leak}`);
      assert.equal(JSON.stringify(result.structuredContent).includes(leak), false);
    }
  } finally {
    await accepted.close();
  }
});

void test("the create tool accepts retentionSeconds and turns it into a header; the quote tool does not accept it", async () => {
  let retentionHeader: string | null = null;
  const fetchImplementation: typeof fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/jobs/quote")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "success",
          request_id: "req_quote",
          data: {
            quoteId: "quote_retention",
            model: "provider/model",
            estimatedCost: "0.10",
            maxCharge: "0.10",
            currency: "USD",
            quantity: "1",
            unit: "per_request",
            expiresAt: "2026-09-13T12:05:00Z",
          },
        }),
      );
    }
    retentionHeader = new Headers(init?.headers).get("x-spicy-retention");
    return Promise.resolve(
      Response.json({
        code: 200,
        msg: "success",
        request_id: "req_create",
        data: { taskId: "job_retention", state: "queued", estimatedCost: "0.10" },
      }),
    );
  };

  const connection = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const tools = await connection.client.listTools();
    const create = tools.tools.find((item) => item.name === "spicyapi_task_create");
    const quote = tools.tools.find((item) => item.name === "spicyapi_task_quote");
    const createProperties = Object.keys(
      (create?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    const quoteProperties = Object.keys(
      (quote?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    assert.ok(createProperties.includes("retentionSeconds"));
    // A quote is not a generation, so retention means nothing to it; accepting it would only stuff
    // the value into the quote request body.
    assert.equal(quoteProperties.includes("retentionSeconds"), false);

    const result = await connection.client.callTool({
      name: "spicyapi_task_create",
      arguments: { model: "provider/model", input: { prompt: "x" }, retentionSeconds: 3600 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(retentionHeader, "3600");
  } finally {
    await connection.close();
  }
});

void test("with a client that does not support elicitation, creating a task takes only the free quote, creates nothing, and says so in advance in the description", async () => {
  let quoteCalls = 0;
  let createCalls = 0;
  const handler = createMcpHandler(
    createSpicyMcpFactory({
      client: apiClient((input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/jobs/quote")) {
          quoteCalls += 1;
          return Promise.resolve(
            Response.json({
              code: 200,
              msg: "success",
              request_id: "req_quote",
              data: {
                quoteId: "quote_no_elicitation",
                model: "provider/model",
                estimatedCost: "0.10",
                maxCharge: "0.10",
                currency: "USD",
                quantity: "1",
                unit: "per_request",
                expiresAt: "2026-09-17T12:05:00Z",
              },
            }),
          );
        }
        createCalls += 1;
        return Promise.resolve(Response.json({ code: 500, msg: "unexpected", request_id: "req" }));
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    }),
    { legacy: "stateless", responseMode: "auto" },
  );
  // No elicitation capability is declared, so the confirmation round never reaches the user.
  const client = new Client(
    { name: "spicy-devkit-no-elicitation", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://spicy-mcp.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  try {
    const tools = await client.listTools();
    const createTool = tools.tools.find((tool) => tool.name === "spicyapi_task_create");
    assert.match(createTool?.description ?? "", /form elicitation/);
    assert.match(createTool?.description ?? "", /no task is created or charged/);

    let succeeded = false;
    try {
      const result = await client.callTool({
        name: "spicyapi_task_create",
        arguments: { model: "provider/model", input: { prompt: "x" } },
      });
      succeeded = result.isError !== true;
    } catch {
      // An error straight from the protocol layer (-32021) counts as a failure too; all that
      // matters here is that no task was created.
    }
    assert.equal(succeeded, false);
    assert.equal(quoteCalls, 1, "exactly one free quote is taken before confirmation");
    assert.equal(createCalls, 0, "no task may be created without confirmation");
  } finally {
    await client.close();
    await handler.close();
  }
});

void test("every live price unit survives the output schema instead of failing the call", async () => {
  // The same failure as the policy tiers above, one field over: `pricing[].unit` was pinned to four
  // values, and the service added `per_1k_characters` for speech models billed by the character.
  // From then on any listing that included one of them - the unfiltered catalogue, modality=audio,
  // task=text-to-speech - and model_get on any of them raised an Output validation error instead
  // of returning models. One unit nobody has shipped yet rides along, so the next one cannot do it
  // again.
  const units = [
    "per_image",
    "per_second",
    "per_request",
    "per_1k_tokens",
    "per_1k_characters",
    "unit-we-have-not-shipped-yet",
  ];
  const items = units.map((unit, index) => ({
    model: `maker/model-${index}/text-to-speech`,
    family: `maker/model-${index}`,
    displayName: `Endpoint ${index}`,
    provider: "Model Creator",
    modality: "audio",
    tasks: ["text-to-speech"],
    async: true,
    mature: false,
    policyTier: "filtered",
    taskTimeoutSeconds: 600,
    enabled: true,
    available: true,
    quantityField: "text",
    pricing: [{ variant: "", unit, price: "0.06", currency: "USD" }],
    startingPrice: { variant: "", unit, price: "0.06", currency: "USD" },
    version: "1",
    availability: "available",
    badges: ["audio_output"],
    relatedModels: [],
    updatedAt: "2026-10-05T00:00:00Z",
  }));
  const characterBilled = items[4]!;
  const fetchImplementation: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const data = url.includes("/models?") ? { total: items.length, items } : characterBilled;
    return Promise.resolve(Response.json({ code: 200, msg: "success", request_id: "req", data }));
  };
  const connection = await connectMcp({
    client: apiClient(fetchImplementation),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const listed = await connection.client.callTool({
      name: "spicyapi_models_list",
      arguments: { modality: "audio" },
    });
    assert.equal(listed.isError, undefined, "a live price unit must not fail the listing");
    const returned = (
      listed.structuredContent as {
        result?: { items?: Array<{ pricing?: Array<{ unit?: string }> }> };
      }
    ).result?.items;
    assert.deepEqual(
      returned?.map((item) => item.pricing?.[0]?.unit),
      units,
      "each unit must reach the agent unchanged",
    );

    const single = await connection.client.callTool({
      name: "spicyapi_model_get",
      arguments: { model: characterBilled.model },
    });
    assert.equal(single.isError, undefined, "model_get on a character-billed model must not fail");
    assert.equal(
      (single.structuredContent as { result?: { startingPrice?: { unit?: string } } }).result
        ?.startingPrice?.unit,
      "per_1k_characters",
    );

    const tool = (await connection.client.listTools()).tools.find(
      (candidate) => candidate.name === "spicyapi_models_list",
    );
    assert.match(
      JSON.stringify(tool?.outputSchema ?? {}),
      /per_1k_characters/,
      "the output schema should name the known units, so an agent can read them",
    );
  } finally {
    await connection.close();
  }
});

void test("task results that are text, transcripts or layers are described where the agent reads them", async () => {
  // Speech-to-text answers in output.text with no assets at all, and layer decomposition returns
  // one asset per layer. The README said so, but an agent reads the tool
  // description, and one that only knew about output.assets[].url reported finished transcriptions
  // as having produced nothing.
  const connection = await connectMcp({
    client: apiClient(() => Promise.reject(new Error("API must not be called"))),
    stateSecret: "0123456789abcdef0123456789abcdef",
  });
  try {
    const tools = (await connection.client.listTools()).tools;
    for (const name of ["spicyapi_task_get", "spicyapi_task_wait"]) {
      const description = tools.find((tool) => tool.name === name)?.description ?? "";
      assert.match(description, /output\.text/, `${name} does not mention output.text`);
      assert.match(description, /transcript/, `${name} does not mention transcripts`);
    }
    const listing = tools.find((tool) => tool.name === "spicyapi_tasks_list");
    assert.match(
      JSON.stringify(listing?.outputSchema ?? {}),
      /requestId/,
      "the task listing schema should carry the contract's requestId",
    );
  } finally {
    await connection.close();
  }
});
