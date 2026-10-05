import { MCP_VERSION } from "../generated/package-version.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
  type CallToolResult,
  type InputRequiredResult,
  type McpServerFactory,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  DOCUMENTATION,
  readOpenApiContract,
  searchDocumentation,
  SpicyApiError,
  SpicyClient,
  type SpicyClientOptions,
  type UploadContentType,
} from "@spicyapi/sdk";

import { expandHomePath, splitUploadRoots } from "./upload-paths.js";
import { inferUploadContentType, UPLOAD_CONTENT_TYPES } from "./upload-types.js";

const SERVER_NAME = "spicyapi";
const SERVER_VERSION = MCP_VERSION;
const CONFIRMATION_KEY = "confirm_billable_operation";

const emptySchema = z.object({});
const confirmationSchema = z.object({ confirm: z.boolean() });
const unknownObjectSchema = z.record(z.string(), z.unknown());
const usdStringSchema = z.string().regex(/^-?[0-9]+(?:\.[0-9]+)?$/);
const taskStateSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled", "expired"]);
const uploadContentTypeSchema = z.enum(UPLOAD_CONTENT_TYPES);
const documentationEntrySchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    url: z.string(),
    keywords: z.array(z.string()),
  })
  .passthrough();
const probeSchema = z
  .object({
    path: z.enum(["/healthz", "/readyz"]),
    ok: z
      .boolean()
      .describe(
        "Whether this one probe answered 2xx. On /readyz this is false on the public surface by design; read `operational` for the verdict.",
      ),
    status: z
      .number()
      .int()
      .describe(
        "HTTP status of this probe. A 404 on /readyz means this deployment exposes no readiness probe here — readiness reveals database and Redis state, so the server registers it only on the admin process. That is not a fault; a real not-ready answer is 503. A 403 or 451 on either probe is a rejection of where the request came from (proxy, gateway, or an unserved region), not a service outage — say so rather than reporting an incident.",
      ),
    body: z.string(),
    error: z.string().optional(),
  })
  .passthrough();
const serviceStatusSchema = z
  .object({
    operational: z
      .boolean()
      .describe(
        "The verdict: is the service usable. Derived from /healthz plus /readyz, where a 404 on /readyz counts as 'no such probe here' rather than a failure. Report this field; do not conclude anything from readiness.ok alone.",
      ),
    health: probeSchema,
    readiness: probeSchema,
    checkedAt: z.string(),
  })
  .passthrough();
const modelPriceSchema = z
  .object({
    variant: z.string(),
    // An open string for the same reason as policyTier below. It was a four-value z.enum until the
    // service started billing speech models per thousand characters; from then on every listing
    // that contained one of them failed with "Output validation error" rather than returning models.
    unit: z
      .string()
      .describe(
        "Known values: per_image, per_second, per_request, per_1k_tokens, per_1k_characters. " +
          "Treat the set as open and ignore a value you do not recognise.",
      ),
    price: usdStringSchema,
    currency: z.literal("USD"),
  })
  .passthrough();
const modelExampleSchema = z
  .object({ id: z.string(), input: unknownObjectSchema, sortWeight: z.number().int() })
  .passthrough();
const apiModelSchema = z
  .object({
    model: z.string(),
    family: z.string(),
    displayName: z.string(),
    provider: z.string(),
    modality: z.enum(["image", "video", "audio", "text"]),
    tasks: z.array(z.string()),
    async: z.boolean(),
    mature: z
      .boolean()
      .describe("Informational model capability metadata; not a platform routing or access gate."),
    // Deliberately an open string rather than a z.enum. This is registerTool's outputSchema, which
    // the MCP SDK validates structuredContent against, and a mismatch throws for the entire tool
    // call - too high a price for a purely descriptive classification field to pay by failing
    // models_list outright.
    // That price was measured on 2026-09-20: three values were hard-coded here while the server
    // already had five, and 16 of the 121 live endpoints carried softened or filtered, so any
    // unfiltered catalogue listing threw "Output validation error". The contract still lists a
    // closed set of five, which is the promise made externally; what matters here is that a sixth
    // tier added server-side does not blow anything up.
    policyTier: z
      .string()
      .describe(
        "Informational model policy metadata; not a platform routing or access gate. " +
          "Known values: unrestricted, borderline, softened, filtered, unspecified. " +
          "softened means the model quietly returns a toned-down result and the task is still charged. " +
          "Treat the set as open and ignore a value you do not recognise.",
      ),
    taskTimeoutSeconds: z.number().int().positive(),
    maxOutputDurationSeconds: z.number().int().positive().optional(),
    enabled: z.boolean(),
    available: z.boolean(),
    quantityField: z.string(),
    pricing: z.array(modelPriceSchema),
    startingPrice: modelPriceSchema.optional(),
    inputSchema: unknownObjectSchema.optional(),
    version: z.string(),
    availability: z.enum(["planned", "available", "preview", "maintenance"]),
    badges: z.array(z.string()),
    relatedModels: z.array(z.string()),
    examples: z.array(modelExampleSchema).optional(),
    updatedAt: z.string(),
  })
  .passthrough();
const modelListSchema = z
  .object({ total: z.number().int().nonnegative(), items: z.array(apiModelSchema) })
  .passthrough();
const balanceSchema = z
  .object({ available: usdStringSchema, held: usdStringSchema, total: usdStringSchema })
  .passthrough();
const taskListSchema = z.object({
  items: z.array(
    z.object({
      taskId: z.string(),
      model: z.string(),
      state: taskStateSchema,
      cost: usdStringSchema,
      settled: z.boolean(),
      createdAt: z.string(),
      deadlineAt: z.string(),
      completedAt: z.string().optional(),
      requestId: z
        .string()
        .optional()
        .describe(
          "X-Request-Id of the request that created the task; matches a synchronous text call to its charge.",
        ),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
});
const usageCountsSchema = z.object({
  calls: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  spend: usdStringSchema.describe("Settled actual charges in USD; excludes pending holds."),
});
const usageReportSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    currency: z.literal("USD"),
    totalCalls: z.number().int().nonnegative(),
    totalSpend: usdStringSchema,
    days: z.array(usageCountsSchema.extend({ day: z.iso.date() }).passthrough()),
    models: z.array(usageCountsSchema.extend({ model: z.string() }).passthrough()),
  })
  .passthrough();
const taskContentStateSchema = z
  .enum(["present", "expired", "purged"])
  .describe(
    "Whether the stored content is still there, and if not, who removed it: `expired` means the retention rules ran, `purged` means the account destroyed it on purpose.",
  );
const taskRetentionSchema = z
  .object({
    outputsExpireAt: z.string().optional(),
    promptsExpireAt: z.string().optional(),
    source: z.enum(["header", "account", "platform"]).optional(),
    purgedAt: z.string().optional(),
    contentRemovedBy: z.enum(["user", "system"]).optional(),
  })
  .passthrough();
/* The purge result keeps these four fields and deliberately does not pass anything else through.
   A tool's return value goes wholesale into the model's context, the session record and any export
   of the conversation - and this action happens at the precise moment the output is being deleted.
   Carrying a ticket, a signed URL or an output key along would leave, in the very message that says
   "destroyed", a thread by which the content could still be retrieved. So this projects through an
   allow-list, and whatever fields the server adds later will not flow out on their own. */
const purgeTaskResultSchema = z
  .object({
    taskId: z.string(),
    contentState: taskContentStateSchema,
    purgedAt: z.string().optional(),
    contentRemovedBy: z.enum(["user", "system"]).optional(),
    billingRetained: z.literal(true),
  })
  .strict();

const taskRecordSchema = z
  .object({
    taskId: z.string(),
    sourceTaskId: z.string().optional(),
    model: z.string(),
    state: taskStateSchema,
    input: unknownObjectSchema.optional(),
    output: unknownObjectSchema.optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    cost: usdStringSchema,
    settled: z.boolean(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
    contentState: taskContentStateSchema.optional(),
    retention: taskRetentionSchema.optional(),
  })
  .passthrough();
/* `uploadTicketSchema` was removed on 2026-09-12: presigned tickets no longer travel through an
   MCP return value. Its only user, `spicyapi_upload_prepare`, was replaced by
   `spicyapi_upload_file`, for the reasons recorded where that tool is registered. */
const uploadedFileSchema = z
  .object({
    fileId: z.string(),
    status: z.literal("ready"),
    bytes: z.number().int().positive(),
    // Open on the way out, unlike the input enum: by the time this is validated the file has
    // already been uploaded, and a type the service learned after this release must not turn that
    // success into an "Output validation error" that hides the URI.
    contentType: z.string(),
    durationSeconds: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    uri: z.string(),
    expiresAt: z.string(),
  })
  .passthrough();
const downloadTicketSchema = z
  .object({ key: z.string(), url: z.string(), expiresAt: z.string() })
  .passthrough();
const createTaskResultSchema = z
  .object({ taskId: z.string(), state: taskStateSchema, estimatedCost: usdStringSchema })
  .passthrough();
const retryTaskResultSchema = createTaskResultSchema.extend({ sourceTaskId: z.string() });
const confirmedCreateTaskResultSchema = createTaskResultSchema.extend({
  idempotencyKey: z.string(),
});
const confirmedRetryTaskResultSchema = retryTaskResultSchema.extend({ idempotencyKey: z.string() });

/* Not every result is a file, and an agent reads the tool description rather than the README: one
   that only knew about output.assets[].url reported finished transcriptions as having produced
   nothing. The shapes come from the contract's TaskOutput, TaskTranscript and TaskOutputAsset.layer. */
const TEXT_AND_LAYER_RESULTS =
  "Some models answer in words instead of a file: speech-to-text and other text results arrive in output.text with no assets, and a transcription may add output.transcript with word timings and the detected language. " +
  "Layer decomposition returns one image asset per layer; stack them by ascending output.assets[].layer.zIndex.";

function resultOf<T extends z.ZodType>(result: T): z.ZodObject<{ result: T }> {
  return z.object({ result });
}

const taskQuoteSchema = z.object({
  quoteId: z.string(),
  model: z.string(),
  estimatedCost: usdStringSchema,
  maxCharge: usdStringSchema,
  currency: z.literal("USD"),
  quantity: z.string(),
  unit: z.string(),
  expiresAt: z.string(),
});

const billableStateSchema = z.object({
  action: z.enum(["create_task", "retry_task", "purge_task"]),
  fingerprint: z.string(),
  quote: taskQuoteSchema.optional(),
  idempotencyKey: z.string(),
});
type BillableState = z.infer<typeof billableStateSchema>;

export const SPICYAPI_MCP_TOOLS = [
  "spicyapi_service_status",
  "spicyapi_docs_search",
  "spicyapi_models_list",
  "spicyapi_model_get",
  "spicyapi_balance_get",
  "spicyapi_usage_get",
  "spicyapi_tasks_list",
  "spicyapi_task_get",
  "spicyapi_task_wait",
  "spicyapi_upload_file",
  "spicyapi_download_url_create",
  "spicyapi_task_quote",
  "spicyapi_task_create",
  "spicyapi_task_retry",
  "spicyapi_task_purge",
] as const;

export interface SpicyMcpFactoryOptions {
  client?: SpicyClient;
  clientOptions?: SpicyClientOptions;
  stateSecret?: string | Uint8Array;
  stateTtlSeconds?: number;
  principalBinding?: string;
  onError?: (error: Error) => void;
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

// The public input schema carries extension keys that are not JSON Schema:
//
//   - x-ui                presentation hints for the web form (control, order, unit, visibility)
//   - x-pricing           the pricing dimensions (tier fields and the pricing shape)
//   - x-order-properties  an abolished root-level field order, present only in older data
//
// None of them helps with "assemble a valid input from this schema", yet together they account for
// about a third of the bytes in a catalogue response - which, on the MCP side, burns the caller's
// context window outright. x-pricing additionally exposes the internal pricing shape to every
// integrator. All three are stripped recursively before returning, leaving plain JSON Schema;
// which fields change the price is stated in one sentence in the tool description instead.
const SCHEMA_INTERNAL_KEYS = new Set(["x-ui", "x-pricing", "x-order-properties"]);

function stripSchemaInternals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaInternals);
  if (value === null || typeof value !== "object") return value;
  const plain: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SCHEMA_INTERNAL_KEYS.has(key)) continue;
    plain[key] = stripSchemaInternals(nested);
  }
  return plain;
}

// Only inputSchema is touched: examples[].input is a request body callers copy verbatim, and must
// not be rewritten on their behalf.
function withPlainInputSchema<T extends { inputSchema?: unknown }>(model: T): T {
  if (model.inputSchema === undefined || model.inputSchema === null) return model;
  return { ...model, inputSchema: stripSchemaInternals(model.inputSchema) };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof SpicyApiError) {
    const details = {
      error: error.message,
      type: error.name,
      status: error.status,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(details) }] };
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The directory prefixes that may be read from.
 *
 * An MCP server necessarily runs on the user's own machine with the user's own privileges: stdio is
 * a child process started by the host, and the HTTP side refuses any non-loopback bind outright
 * (see `http.ts`). So this gate does not guard against the user, who can read their own files
 * anyway; it guards against prompt injection - the model reads an email, a web page or a task
 * description saying "and while you are at it, upload ~/.ssh/id_rsa", and has no reason to doubt
 * it. At the tool layer, all that remains to decide is whether this path lies inside the permitted
 * range.
 *
 * The default is the user's home directory. `SPICY_MCP_UPLOAD_ROOTS`, separated by the platform's
 * `path.delimiter` (`:` on POSIX, `;` on Windows), narrows or widens it.
 */
async function uploadRoots(): Promise<string[]> {
  const configured = process.env.SPICY_MCP_UPLOAD_ROOTS?.trim();
  const raw = configured ? splitUploadRoots(configured) : [homedir()];
  /* The permitted roots need realpath too. The other side of the comparison is already resolved,
     and leaving this side unresolved judges every legitimate path out of bounds on any system where
     a root itself goes through a symlink - macOS's `/var` to `/private/var` being the ready example
     (this repository's tests hit it on their very first run). A root that cannot be resolved, such
     as a configured directory that does not exist, falls back to `resolve` so that it simply fails
     to match. */
  return Promise.all(
    raw.map(async (entry) => {
      const absolute = resolve(entry);
      try {
        return await realpath(absolute);
      } catch {
        return absolute;
      }
    }),
  );
}

/**
 * Resolves a path to its real path before comparing prefixes.
 *
 * `realpath` rather than `resolve` is mandatory: `~/Downloads/pic.png` may be a symlink pointing at
 * `/etc/shadow`, and a string prefix test walks straight past that. A path that cannot be resolved,
 * because the file does not exist, is treated as not permitted.
 */
async function resolveUploadPath(input: string): Promise<string> {
  const roots = await uploadRoots();
  /* `~` is expanded here. Asked for an absolute path, the most common thing a model writes is
     `~/Desktop/photo.jpg`, and `isAbsolute("~/...")` is false - the previous version filed that
     under "not inside a permitted directory", so the model went off to change the directory, which
     is what the message pointed at, while `~` sits squarely in the middle of the permitted range.
     Expanding it is closer to what the user meant than refusing it. On Windows a model writes
     `~\Desktop\photo.jpg` just as readily, so that is expanded too. */
  const expanded = expandHomePath(input);

  /* Three failures get three different sentences.
     The previous version answered "not inside a permitted directory" to all of them, on the stated
     grounds that distinguishing "does not exist" from "not permitted" amounts to directory probing
     - which holds for a network service and not here: this process runs on the user's own machine
     with the user's own privileges, and the default root is their home directory, which they can
     already `ls`. Meanwhile the prompt injection it guards against, coaxing an upload of
     `~/.ssh/id_rsa`, has its target inside the home directory anyway, so vagueness helps not at all
     and merely sends the model off correcting a correct path in the wrong direction. */
  if (!expanded || !isAbsolute(expanded)) {
    throw new SpicyApiError(
      `path must be absolute, for example ${resolve(homedir(), "Desktop/photo.png")} — ask the user for the full path`,
      { status: 400 },
    );
  }
  let real: string;
  try {
    real = await realpath(expanded);
  } catch {
    throw new SpicyApiError(`no such file: ${expanded}`, { status: 404 });
  }
  const allowed = roots.some(
    (root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep),
  );
  if (!allowed) {
    throw new SpicyApiError(
      `this server may only read files under ${roots.join(", ")} — ${real} is outside that`,
      { status: 403 },
    );
  }
  return real;
}

async function safely(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function fingerprint(action: BillableState["action"], args: unknown): string {
  return createHash("sha256")
    .update(`${action}\0${stableJson(args)}`)
    .digest("hex");
}

/* Whatever is said after a user declines has to be true of every action.
   Creating a task has already taken a quote before the confirmation appears - a quote creates no
   task, holds no funds and costs nothing, but it is a genuine SpicyAPI request, so "no SpicyAPI
   request was made" would be false of it. Retry and purge send nothing at all before confirmation,
   so that sentence still holds for them. */
function declinedMessage(action: BillableState["action"]): string {
  switch (action) {
    case "create_task":
      return "operation declined; no task was created and no funds were reserved or charged (only the free price quote had been requested)";
    case "retry_task":
      return "operation declined; no retry task was created and no SpicyAPI request was made";
    case "purge_task":
      return "operation declined; nothing was destroyed and no SpicyAPI request was made";
  }
}

function stateKey(options: SpicyMcpFactoryOptions): Uint8Array {
  if (options.stateSecret !== undefined) {
    const key =
      typeof options.stateSecret === "string"
        ? new TextEncoder().encode(options.stateSecret)
        : options.stateSecret;
    if (key.byteLength < 32)
      throw new RangeError("MCP request-state secret must be at least 32 bytes");
    return key;
  }
  const apiKey = options.clientOptions?.apiKey ?? process.env.SPICY_API_KEY;
  if (apiKey) return createHash("sha256").update(`spicyapi.mcp.state\0${apiKey}`).digest();
  return randomBytes(32);
}

export function createSpicyMcpFactory(options: SpicyMcpFactoryOptions = {}): McpServerFactory {
  const client = options.client ?? new SpicyClient(options.clientOptions);
  const principalBinding = options.principalBinding ?? "local-spicyapi-user";
  const codec = createRequestStateCodec<BillableState>({
    key: stateKey(options),
    ttlSeconds: options.stateTtlSeconds ?? 600,
    bind: (ctx) => `${ctx.mcpReq.method}\0${principalBinding}`,
  });

  return () => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        instructions:
          "Use the live model catalog as the only source of model IDs and input schemas; reuse a complete model record already obtained in this workflow. Task creation quotes internally and requires user confirmation; do not call the separate quote tool first unless comparing prices. Retry also requires confirmation. Read ready output.assets[].url directly without a download-ticket call. Health and balance tools are optional diagnostics. Never invent cancellation APIs; they are not part of the public contract. Content destruction does exist: spicyapi_task_purge removes a terminal task's generated media, result payload, prompt and other input text while leaving the billing record intact, and it is irreversible, so call it only when the user asked for that specific task. When the user refers to a file on their own computer, call spicyapi_upload_file with the absolute path and put the returned spicy:// URI in the model input; ask the user for the full path rather than guessing a folder.",
        cacheHints: {
          "tools/list": { ttlMs: 60_000, cacheScope: "private" },
          "resources/list": { ttlMs: 300_000, cacheScope: "public" },
          "prompts/list": { ttlMs: 300_000, cacheScope: "public" },
        },
        inputRequired: { maxRounds: 3, roundTimeoutMs: 600_000, legacyShim: true },
        requestState: { verify: (state, ctx) => codec.verify(state, ctx) },
      },
    );
    server.server.onerror = (error) => (options.onError ?? console.error)(error);

    async function requireUserConfirmation(
      action: BillableState["action"],
      args: Record<string, unknown>,
      ctx: ServerContext,
      message: string,
      execute: (
        idempotencyKey: string,
        quote?: z.infer<typeof taskQuoteSchema>,
      ) => Promise<unknown>,
    ): Promise<CallToolResult | InputRequiredResult> {
      const expectedFingerprint = fingerprint(action, args);
      const parsedState = billableStateSchema.safeParse(ctx.mcpReq.requestState<BillableState>());
      const state = parsedState.success ? parsedState.data : undefined;
      if (state && (state.action !== action || state.fingerprint !== expectedFingerprint)) {
        return toolError(
          new Error("confirmed request state does not match the current tool arguments"),
        );
      }

      const response = inputResponse(ctx.mcpReq.inputResponses, CONFIRMATION_KEY);
      if (state && response.kind === "elicit" && response.action !== "accept") {
        return toolError(new Error(declinedMessage(action)));
      }
      const confirmation = acceptedContent(
        ctx.mcpReq.inputResponses,
        CONFIRMATION_KEY,
        confirmationSchema,
      );
      if (state && confirmation?.confirm === true) {
        try {
          return jsonResult(await execute(state.idempotencyKey, state.quote));
        } catch (error) {
          const result = toolError(error);
          result.content.push({
            type: "text",
            text: JSON.stringify({
              idempotencyKey: state.idempotencyKey,
              recovery:
                "Reuse this idempotencyKey with the unchanged request after an uncertain response.",
            }),
          });
          return result;
        }
      }

      const suppliedKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
      const idempotencyKey = state?.idempotencyKey ?? suppliedKey ?? randomUUID();
      let quote = state?.quote;
      if (action === "create_task" && !quote) {
        try {
          quote = taskQuoteSchema.parse(
            await client.quoteTask(
              {
                model: String(args.model),
                input: args.input as Record<string, unknown>,
                ...(typeof args.callBackUrl === "string" ? { callBackUrl: args.callBackUrl } : {}),
              },
              { signal: ctx.mcpReq.signal },
            ),
          );
        } catch (error) {
          return toolError(error);
        }
      }
      const quoteMessage = quote
        ? ` Estimated charge: USD ${quote.estimatedCost}; maximum charge: USD ${quote.maxCharge}. Quote expires: ${quote.expiresAt}.`
        : "";
      const requestState = await codec.mint(
        { action, fingerprint: expectedFingerprint, idempotencyKey, ...(quote ? { quote } : {}) },
        ctx,
      );
      /* "the price and balance are checked before acceptance" is not true of a purge - that path
         has no quote, no balance and no idempotency key to preserve, and reciting it would leave
         the user believing there is still a gate that could save them. */
      const assurance =
        action === "purge_task"
          ? " This is not reversible and there is no undo. Your billing records are kept: the charge, model, state, timestamps and request ID stay queryable afterwards."
          : ` Before accepting the request, SpicyAPI checks the model’s current input requirements, price and availability, your API key permissions, and available funds. Idempotency-Key: ${idempotencyKey}`;
      return inputRequired({
        inputRequests: {
          [CONFIRMATION_KEY]: inputRequired.elicit({
            message: `${message}${quoteMessage}${assurance}`,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState,
      });
    }

    server.registerTool(
      "spicyapi_service_status",
      {
        title: "Check SpicyAPI service status",
        description:
          "Read public health and readiness endpoints for diagnostics or an explicit status request. Not a prerequisite for task creation. No API key is required. " +
          "Report the `operational` field. On the public surface /readyz answers 404 by design — readiness exposes database and Redis state, so it is registered only on the admin process — and `operational` already accounts for that. Do not report a 404 there as an outage.",
        inputSchema: emptySchema,
        outputSchema: resultOf(serviceStatusSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (_args, ctx) => safely(() => client.getStatus({ signal: ctx.mcpReq.signal })),
    );

    server.registerTool(
      "spicyapi_docs_search",
      {
        title: "Search SpicyAPI documentation",
        description: "Search the bundled index of verified first-party documentation URLs.",
        inputSchema: z.object({
          query: z.string().default(""),
          limit: z.number().int().min(1).max(25).default(10),
        }),
        outputSchema: resultOf(z.array(documentationEntrySchema)),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      ({ query, limit }) => jsonResult(searchDocumentation(query, limit)),
    );

    server.registerTool(
      "spicyapi_models_list",
      {
        title: "List callable SpicyAPI models",
        description:
          "Discover enabled models and account-specific prices. Fetch only the selected model for its schema, or set includeSchema to reuse complete records without another model_get call. " +
          "Returned input schemas are plain JSON Schema; display-only and rate-card annotations are removed. " +
          "Some input values change the price; task_create obtains the exact request quote for confirmation. " +
          "Use pricing entries for comparisons rather than calculating the accepted charge yourself.",
        inputSchema: z.object({
          modality: z.enum(["image", "video", "audio", "text"]).optional(),
          provider: z.string().optional(),
          task: z.string().optional(),
          search: z.string().optional(),
          includeSchema: z.boolean().default(false),
          includeExamples: z.boolean().default(false),
        }),
        outputSchema: resultOf(modelListSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) =>
        safely(async () => {
          const list = await client.listModels({ ...args, signal: ctx.mcpReq.signal });
          return { ...list, items: list.items.map(withPlainInputSchema) };
        }),
    );

    server.registerTool(
      "spicyapi_model_get",
      {
        title: "Get one SpicyAPI model",
        description:
          "Return one exact model, its live input schema, pricing, policy and availability. Reuse a complete record already obtained from models_list with includeSchema. " +
          "The input schema is plain JSON Schema; display-only and rate-card annotations are removed. " +
          "Some input values change the price; task_create obtains the exact request quote for confirmation. " +
          "Use pricing entries for comparisons rather than calculating the accepted charge yourself.",
        inputSchema: z.object({ model: z.string().min(1) }),
        outputSchema: resultOf(apiModelSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ model }, ctx) =>
        safely(async () =>
          withPlainInputSchema(await client.getModel(model, { signal: ctx.mcpReq.signal })),
        ),
    );

    server.registerTool(
      "spicyapi_balance_get",
      {
        title: "Get SpicyAPI USD balance",
        description:
          "Return available, held, and total balance as exact decimal USD strings when requested or diagnosing funds. Task creation already checks funds; this is not a prerequisite.",
        inputSchema: emptySchema,
        outputSchema: resultOf(balanceSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (_args, ctx) => safely(() => client.getBalance({ signal: ctx.mcpReq.signal })),
    );

    server.registerTool(
      "spicyapi_usage_get",
      {
        title: "Get current SpicyAPI key usage",
        description:
          "Read task counts and settled actual USD spend for the current API key, grouped by creation day and model. " +
          "Only from/to dates are accepted: UTC [from,to), at most 92 days; defaults to seven days ending tomorrow UTC. " +
          "Money is returned as exact decimal strings; pending holds are excluded and late settlement can change prior-day spend. " +
          "This is not account balance or remaining key budget, and is not a generation prerequisite. " +
          "Use for requested usage reports; respect Retry-After on rate limits.",
        inputSchema: z
          .object({
            from: z.iso
              .date()
              .optional()
              .describe("Inclusive UTC date, YYYY-MM-DD. Defaults to seven days before to."),
            to: z.iso
              .date()
              .optional()
              .describe("Exclusive UTC date, YYYY-MM-DD. Defaults to tomorrow UTC."),
          })
          .strict(),
        outputSchema: resultOf(usageReportSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ from, to }, ctx) =>
        safely(() =>
          client.getUsage({
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            signal: ctx.mcpReq.signal,
          }),
        ),
    );

    server.registerTool(
      "spicyapi_tasks_list",
      {
        title: "List current SpicyAPI key tasks",
        description:
          "Discover current-key task history with metadata only, without fetching each result. " +
          "Dates are UTC [from,to), default seven days, at most 92 days. Keep from/to fixed across pages and pass nextCursor unchanged. " +
          "Limit defaults to 20, maximum 100. Cost is an exact USD string and is final only when settled. " +
          "Use task_get only for selected results; use usage_get for settled spending including hidden tasks. " +
          "This is not a polling endpoint or a prerequisite to generation.",
        inputSchema: z
          .object({
            from: z.iso.date().optional(),
            to: z.iso.date().optional(),
            state: taskStateSchema.optional(),
            model: z.string().min(1).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z.string().min(1).optional(),
          })
          .strict(),
        outputSchema: resultOf(taskListSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ from, to, state, model, limit, cursor }, ctx) =>
        safely(() =>
          client.listTasks({
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(state === undefined ? {} : { state }),
            ...(model === undefined ? {} : { model }),
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
            signal: ctx.mcpReq.signal,
          }),
        ),
    );

    server.registerTool(
      "spicyapi_task_get",
      {
        title: "Get a SpicyAPI task",
        description:
          "Read a task created by the current API key, including ready output.assets[].url links. Use those URLs directly without your API key; query again if assets are pending or URLs have expired. A verified complete v2 webhook already contains the result. Unknown and inaccessible IDs are both 404. " +
          TEXT_AND_LAYER_RESULTS,
        inputSchema: z.object({ taskId: z.string().min(1) }),
        outputSchema: resultOf(taskRecordSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ taskId }, ctx) =>
        safely(() => client.getTask(taskId, { signal: ctx.mcpReq.signal })),
    );

    server.registerTool(
      "spicyapi_task_wait",
      {
        title: "Wait briefly for a SpicyAPI task",
        description:
          "Wait for a task for up to 300 seconds and read ready output.assets[].url directly without a download-ticket call. By default, polling backs off from about 2 to at most 10 seconds; an explicit intervalSeconds stays fixed. Prefer signed webhooks for production; a complete verified v2 callback needs no extra task_get. A local wait timeout does not cancel the task. " +
          TEXT_AND_LAYER_RESULTS,
        inputSchema: z.object({
          taskId: z.string().min(1),
          intervalSeconds: z
            .number()
            .int()
            .min(1)
            .max(60)
            .optional()
            .describe(
              "Fixed polling interval in seconds. Omit to use adaptive SDK backoff from about 2 to at most 10 seconds.",
            ),
          timeoutSeconds: z.number().int().min(1).max(300).default(60),
        }),
        outputSchema: resultOf(taskRecordSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ taskId, intervalSeconds, timeoutSeconds }, ctx) =>
        safely(() =>
          client.waitForTask(taskId, {
            ...(intervalSeconds === undefined ? {} : { intervalMs: intervalSeconds * 1_000 }),
            timeoutMs: timeoutSeconds * 1_000,
            signal: ctx.mcpReq.signal,
          }),
        ),
    );

    /* Local file upload. This is the only complete upload entry point on the MCP side.
     *
     * It used to be `spicyapi_upload_prepare`, which signed a presigned PUT ticket, handed it to
     * the model, and then... nothing. In the MCP protocol a tool's return value is content for the
     * model to read; the host does not execute URLs inside it, so nobody could ever send that PUT.
     * Its own description said "Prefer SDK uploadFile or CLI files upload for a complete local-file
     * upload", which amounts to admitting it was not a complete flow. It broke a step earlier still:
     * it required an exact `bytes` count, which a model in an MCP-only environment has no way to
     * produce.
     *
     * That also fixed a leak: the ticket - carrying the CF account id, the bucket name and the
     * userID inside the URL - was written into both `content[0].text` and `structuredContent`, and
     * therefore into the model's context, the session record and any export of the conversation,
     * while `references/safety.md` in this repository requires presigned URLs to be redacted. It
     * leaked, and nobody used it to complete an upload.
     *
     * It now takes a path alone; the SDK reads the bytes locally and sends them locally, and no
     * uploadUrl appears in the return value. When a user says "upload that picture on my desktop",
     * the model repeating the path back is all that is needed. */
    server.registerTool(
      "spicyapi_upload_file",
      {
        title: "Upload a local file to SpicyAPI",
        description:
          "Read a file from this computer, upload it, and return the spicy:// URI to put in a model input field. Use this whenever the user refers to a file on their machine. Images (JPEG, PNG, WebP, GIF) up to 10 MiB; MP4/WebM video and MP3/WAV audio up to 90 MiB; reference documents (PDF, Word, Excel, PowerPoint, Keynote, Pages, Numbers, TXT, Markdown) up to 90 MiB for fields such as reference_file_url. Public HTTPS media URLs need no upload at all — pass them straight to the model input when its schema accepts a URL.",
        inputSchema: z.object({
          path: z
            .string()
            .min(1)
            .describe("Absolute path to the file on this computer, as the user gave it."),
          contentType: uploadContentTypeSchema
            .optional()
            .describe("Only when the file extension is missing or wrong; otherwise inferred."),
        }),
        outputSchema: resultOf(uploadedFileSchema),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ path, contentType }, ctx) =>
        safely(async () => {
          const resolved = await resolveUploadPath(path);
          return client.uploadFile(resolved, {
            /* Named on this side rather than left to the SDK, whose extension table and types stop
               at the eight media types; documents pass through it unchanged at runtime and are
               checked by the server. See upload-types.ts. */
            contentType: (contentType ?? inferUploadContentType(resolved)) as UploadContentType,
            signal: ctx.mcpReq.signal,
          });
        }),
    );

    /* `spicyapi_upload_commit` was removed on 2026-09-17. It wanted a fileId in the state "the
       bytes have been PUT but not committed", and no path on the MCP side produces such a fileId:
       `upload_prepare`, which signed the tickets, was removed long ago, and `upload_file` reads the
       file, PUTs it and commits within a single call, handing over no fileId when it fails. Keeping
       it would only leave the model believing it should first complete a PUT it cannot send. The
       SDK's step-by-step upload still offers `commitUploadedFile`, where the caller really does
       hold a ticket. */

    server.registerTool(
      "spicyapi_download_url_create",
      {
        title: "Create a SpicyAPI output download URL",
        description:
          "Create a short-lived signed URL for an output owned by the current task and API key, for legacy integrations or explicit link renewal. Prefer existing ready output.assets[].url from task_get, task_wait, or a verified v2 webhook; no ticket call is needed for those links.",
        inputSchema: z.object({ taskId: z.string().min(1), key: z.string().optional() }),
        outputSchema: resultOf(downloadTicketSchema),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ taskId, key }, ctx) =>
        safely(() => client.createDownloadUrl(taskId, key, { signal: ctx.mcpReq.signal })),
    );

    const createTaskSchema = z.object({
      model: z.string().min(1),
      input: z.record(z.string(), z.unknown()),
      callBackUrl: z.string().optional(),
      idempotencyKey: z.string().min(1).optional(),
      retentionSeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "How long SpicyAPI keeps this task's generated media, result payload, prompt and other input text, in seconds. Only ever shortens: the account settings and platform maximum still apply, so this cannot extend retention. 0 removes them as soon as the task reaches a terminal state. Set it only when the user asked for a shorter window; the accepted deadlines come back in the task record's retention field.",
        ),
    });
    server.registerTool(
      "spicyapi_task_quote",
      {
        title: "Quote an exact SpicyAPI request",
        description:
          "Compare an exact request price without creating a task or reserving funds. Returns a five-minute USD estimate and maximum charge. task_create already obtains its own quote and confirmation; do not call this tool as a routine prerequisite.",
        inputSchema: createTaskSchema.omit({ idempotencyKey: true, retentionSeconds: true }),
        outputSchema: resultOf(taskQuoteSchema),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) => safely(() => client.quoteTask(args, { signal: ctx.mcpReq.signal })),
    );
    server.registerTool(
      "spicyapi_task_create",
      {
        title: "Create a billable SpicyAPI task",
        description:
          "Obtain the exact request quote, show its USD estimate and maximum charge for user confirmation, then reserve funds and create an asynchronous task. Do not call task_quote first unless independently comparing prices. " +
          "The confirmation needs an MCP client that supports form elicitation; if the client does not, the call fails after the free quote and no task is created or charged.",
        inputSchema: createTaskSchema,
        outputSchema: resultOf(confirmedCreateTaskResultSchema),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) =>
        requireUserConfirmation(
          "create_task",
          args,
          ctx,
          `Create a billable task using ${args.model}?`,
          async (idempotencyKey, quote) => {
            if (!quote) throw new Error("confirmed quote is missing; request a new confirmation");
            return {
              idempotencyKey,
              ...(await client.createTask(
                {
                  model: args.model,
                  input: args.input,
                  ...(args.callBackUrl === undefined ? {} : { callBackUrl: args.callBackUrl }),
                  quoteId: quote.quoteId,
                  expectedCost: quote.estimatedCost,
                },
                {
                  idempotencyKey,
                  ...(args.retentionSeconds === undefined
                    ? {}
                    : { retentionSeconds: args.retentionSeconds }),
                  signal: ctx.mcpReq.signal,
                },
              )),
            };
          },
        ),
    );

    const retryTaskSchema = z.object({
      taskId: z.string().min(1),
      idempotencyKey: z.string().min(1).optional(),
    });
    server.registerTool(
      "spicyapi_task_retry",
      {
        title: "Retry a billable SpicyAPI task",
        description:
          "Create a new task from a failed or expired source. Requires a user confirmation round.",
        inputSchema: retryTaskSchema,
        outputSchema: resultOf(confirmedRetryTaskResultSchema),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) =>
        requireUserConfirmation(
          "retry_task",
          args,
          ctx,
          `Retry source task ${args.taskId} as a new billable task?`,
          async (idempotencyKey) => ({
            idempotencyKey,
            ...(await client.retryTask(args.taskId, { idempotencyKey, signal: ctx.mcpReq.signal })),
          }),
        ),
    );

    server.registerTool(
      "spicyapi_task_purge",
      {
        title: "Destroy a SpicyAPI task's stored content",
        description:
          "Permanently destroy one terminal task's stored content: generated media, result payload, prompt, and input text. " +
          "This destroys content, not the record of what it cost — the ledger entry, charged amount, model, state, timestamps and request ID all stay queryable afterwards, so this never hides or reverses a charge and never refunds anything. " +
          "It cannot be undone and there is no per-output granularity: the unit is one whole task. Download any result the user still wants before calling this. " +
          "Only tasks in a terminal state are accepted. An accepted task cannot be canceled and there is no cancellation API, so for a queued or running task wait until it finishes (task_wait), then purge it. Repeating the call on an already destroyed task succeeds and changes nothing. " +
          "Requires a user confirmation round.",
        inputSchema: z.object({
          taskId: z
            .string()
            .min(1)
            .describe(
              "The exact task whose content should be destroyed. Only call this for a task the user named; never sweep task history on your own initiative.",
            ),
        }),
        outputSchema: resultOf(purgeTaskResultSchema),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) =>
        requireUserConfirmation(
          "purge_task",
          args,
          ctx,
          `Permanently destroy the stored content of task ${args.taskId} — generated media, result payload, prompt and input text?`,
          async () => {
            const purged = await client.purgeTask(args.taskId, { signal: ctx.mcpReq.signal });
            /* Projected through an allow-list rather than forwarding the server's response
               verbatim; see the comment on purgeTaskResultSchema. `billingRetained` is fixed here
               because it is a fact the contract guarantees, and should not depend on the server
               remembering to return it every time. */
            return {
              taskId: purged.taskId,
              contentState: purged.contentState,
              ...(purged.purgedAt === undefined ? {} : { purgedAt: purged.purgedAt }),
              ...(purged.contentRemovedBy === undefined
                ? {}
                : { contentRemovedBy: purged.contentRemovedBy }),
              billingRetained: true as const,
            };
          },
        ),
    );

    server.registerResource(
      "spicyapi-documentation-index",
      "spicyapi://docs/index",
      {
        title: "SpicyAPI documentation index",
        description: "Verified first-party documentation topics and URLs.",
        mimeType: "application/json",
        cacheHint: { ttlMs: 300_000, cacheScope: "public" },
      },
      (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(DOCUMENTATION, null, 2),
          },
        ],
      }),
    );
    server.registerResource(
      "spicyapi-openapi-contract",
      "spicyapi://contract/openapi",
      {
        title: "SpicyAPI public OpenAPI contract",
        description: "The package-pinned public API contract used to generate SDK types.",
        mimeType: "application/yaml",
        cacheHint: { ttlMs: 300_000, cacheScope: "public" },
      },
      async (uri) => ({
        contents: [
          { uri: uri.href, mimeType: "application/yaml", text: await readOpenApiContract() },
        ],
      }),
    );

    server.registerPrompt(
      "spicyapi_generation_workflow",
      {
        title: "Plan a safe SpicyAPI generation",
        description:
          "Build a workflow using the live model schema, confirmed task creation, and directly usable results.",
        argsSchema: z.object({ goal: z.string().min(1), model: z.string().optional() }),
      },
      ({ goal, model }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Goal: ${goal}\n${model ? `Candidate model: ${model}\n` : ""}Use spicyapi_models_list to discover a model, then spicyapi_model_get only if its full live input schema is not already available. Do not invent fields. Call spicyapi_task_create directly: it obtains the exact quote and requests confirmation of the USD estimate and maximum charge. Use the separate quote tool only for price comparisons, and health/balance tools only when requested or diagnosing a problem. Preserve the logical idempotency key and accepted task ID. Prefer a verified webhook for long tasks; otherwise use bounded task_wait. A complete verified v2 webhook needs no extra task_get. Use ready output.assets[].url directly without sending the API key to storage; poll only for pending assets or expired URLs. Copy durable results to storage the user controls.`,
            },
          },
        ],
      }),
    );

    return server;
  };
}

export function createSpicyMcpServer(options: SpicyMcpFactoryOptions = {}): McpServer {
  return createSpicyMcpFactory(options)({ era: "modern" }) as McpServer;
}
