import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { readOpenApiContract, SpicyClient } from "@spicyapi/sdk";

import { createSpicyMcpFactory, SPICYAPI_MCP_TOOLS } from "../src/mcp/server.js";
import { expandHomePath, splitUploadRoots } from "../src/mcp/upload-paths.js";
import { UPLOAD_CONTENT_TYPES } from "../src/mcp/upload-types.js";

/* Uploading a local file used to be impossible on the MCP side: there was only `upload_prepare`,
   which handed a presigned PUT ticket to the model, and nobody could send that PUT. These tests
   guard two things:

     1. `spicyapi_upload_file` really completes read file, upload, commit, return a spicy:// URI;
     2. no presigned URL appears in the return value - the old ticket was written into both content
        and structuredContent, and therefore into the model's context and the session record, while
        safety.md in this repository requires presigned URLs to be redacted. */

const PRESIGNED =
  "https://fee727dd104ab86a982d8b79462c32a3.r2.cloudflarestorage.com/spicy-production-inputs/user-uploads/2026/09/12/pending/usr_a/file_1/tok.png?X-Amz-Signature=deadbeef";

let workspace: string | undefined;
async function tempFile(name: string, body: string): Promise<string> {
  workspace ??= await mkdtemp(join(tmpdir(), "spicy-upload-"));
  const path = join(workspace, name);
  await writeFile(path, body);
  return path;
}

/** A fake backend: sign the ticket, accept the PUT, confirm - none of it leaving the machine. */
function stubFetch(seen: { put?: string } = {}): typeof fetch {
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/common/upload-url")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "",
          request_id: "req_1",
          data: {
            fileId: "file_1",
            key: "user-uploads/2026/09/12/pending/usr_a/file_1/tok.png",
            uploadUrl: PRESIGNED,
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            expiresAt: "2026-09-12T00:20:00Z",
            maxBytes: 10 * 1024 * 1024,
          },
        }),
      );
    }
    if (url.startsWith(PRESIGNED.split("?")[0]!)) {
      seen.put = String(init?.method ?? "GET");
      return Promise.resolve(new Response("", { status: 200 }));
    }
    if (url.includes("/files/file_1/commit")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "",
          request_id: "req_2",
          data: {
            fileId: "file_1",
            status: "ready",
            bytes: 7,
            contentType: "image/png",
            sha256: "a".repeat(64),
            uri: "spicy://file_1",
            expiresAt: "2026-09-13T00:00:00Z",
          },
        }),
      );
    }
    return Promise.resolve(Response.json({ code: 500, msg: "unexpected" }, { status: 500 }));
  };
}

async function connect(fetchImplementation: typeof fetch) {
  const handler = createMcpHandler(
    createSpicyMcpFactory({
      client: new SpicyClient({
        apiKey: "sk_mcp_secret",
        apiBaseUrl: "http://127.0.0.1:4030/api/v1",
        serviceBaseUrl: "http://127.0.0.1:4030",
        fetch: fetchImplementation,
        maxRetries: 0,
      }),
      stateSecret: "0123456789abcdef0123456789abcdef",
    }),
    { legacy: "stateless", responseMode: "auto" },
  );
  const client = new Client(
    { name: "spicy-devkit-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
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

void test("the upload tool is in the tool list, and the old prepare and orphaned commit are gone", () => {
  assert.ok((SPICYAPI_MCP_TOOLS as readonly string[]).includes("spicyapi_upload_file"));
  assert.ok(!(SPICYAPI_MCP_TOOLS as readonly string[]).includes("spicyapi_upload_prepare"));
  // The MCP side issues no tickets, so there is no "PUT but not committed" fileId to hand it.
  assert.ok(!(SPICYAPI_MCP_TOOLS as readonly string[]).includes("spicyapi_upload_commit"));
});

void test("SPICY_MCP_UPLOAD_ROOTS splits on the platform separator, leaving a Windows drive letter intact", () => {
  assert.deepEqual(splitUploadRoots("/Users/me/Pictures:/Volumes/media", path.posix), [
    "/Users/me/Pictures",
    "/Volumes/media",
  ]);
  assert.deepEqual(splitUploadRoots("C:\\Users\\me\\Pictures; D:\\media ;", path.win32), [
    "C:\\Users\\me\\Pictures",
    "D:\\media",
  ]);
});

void test("~/ expands on every platform, ~\\ only on Windows", () => {
  assert.equal(
    expandHomePath("~/Desktop/photo.png", "/Users/me", path.posix),
    "/Users/me/Desktop/photo.png",
  );
  assert.equal(
    expandHomePath("~\\Desktop\\photo.png", "C:\\Users\\me", path.win32),
    "C:\\Users\\me\\Desktop\\photo.png",
  );
  assert.equal(
    expandHomePath("~/Desktop/photo.png", "C:\\Users\\me", path.win32),
    "C:\\Users\\me\\Desktop\\photo.png",
  );
  // On POSIX a backslash is a legal filename character and is not read as home-directory notation;
  // an absolute path is returned unchanged.
  assert.equal(expandHomePath("~\\Desktop", "/Users/me", path.posix), "~\\Desktop");
  assert.equal(expandHomePath("/tmp/a.png", "/Users/me", path.posix), "/tmp/a.png");
});

void test("a local file goes through the whole chain, returning a spicy:// URI and no presigned URL", async () => {
  const path = await tempFile("reference.png", "fake-png-bytes");
  process.env.SPICY_MCP_UPLOAD_ROOTS = workspace!;
  const seen: { put?: string } = {};
  const connection = await connect(stubFetch(seen));
  try {
    const result = await connection.client.callTool({
      name: "spicyapi_upload_file",
      arguments: { path },
    });
    const text = JSON.stringify(result);
    assert.match(text, /spicy:\/\/file_1/);
    assert.equal(seen.put, "PUT", "the bytes must genuinely be PUT");
    assert.ok(!text.includes("r2.cloudflarestorage.com"), "an object-storage URL appeared in the return value");
    assert.ok(!text.includes("X-Amz-Signature"), "a signature appeared in the return value");
    assert.ok(!text.includes("spicy-production-inputs"), "a bucket name appeared in the return value");
  } finally {
    await connection.close();
    delete process.env.SPICY_MCP_UPLOAD_ROOTS;
  }
});

void test("a path outside the permitted range is refused, and the file is not read", async () => {
  const outside = await tempFile("secret.png", "nope");
  process.env.SPICY_MCP_UPLOAD_ROOTS = join(tmpdir(), "spicy-roots-that-do-not-exist");
  const seen: { put?: string } = {};
  const connection = await connect(stubFetch(seen));
  try {
    const result = await connection.client.callTool({
      name: "spicyapi_upload_file",
      arguments: { path: outside },
    });
    assert.equal(result.isError, true);
    assert.equal(seen.put, undefined, "a refused path must produce no upload at all");
  } finally {
    await connection.close();
    delete process.env.SPICY_MCP_UPLOAD_ROOTS;
  }
});

void test("relative paths are never accepted", async () => {
  process.env.SPICY_MCP_UPLOAD_ROOTS = workspace ?? tmpdir();
  const seen: { put?: string } = {};
  const connection = await connect(stubFetch(seen));
  try {
    const result = await connection.client.callTool({
      name: "spicyapi_upload_file",
      arguments: { path: "../../etc/passwd" },
    });
    assert.equal(result.isError, true);
    assert.equal(seen.put, undefined);
  } finally {
    await connection.close();
    delete process.env.SPICY_MCP_UPLOAD_ROOTS;
  }
});

/** Like stubFetch, but records the declared content type and echoes it back from the commit. */
function echoingStub(seen: { declared?: string; put?: boolean; tickets: number }): typeof fetch {
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/common/upload-url")) {
      seen.tickets += 1;
      seen.declared = (JSON.parse(String(init?.body)) as { contentType: string }).contentType;
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "",
          request_id: "req_1",
          data: {
            fileId: "fil_doc",
            key: "spicy://f/fil_doc",
            uploadUrl: "http://127.0.0.1:4030/put/fil_doc",
            method: "PUT",
            headers: { "Content-Type": seen.declared },
            expiresAt: "2026-10-05T00:20:00Z",
            maxBytes: 90 * 1024 * 1024,
          },
        }),
      );
    }
    if (url.endsWith("/put/fil_doc")) {
      seen.put = true;
      return Promise.resolve(new Response("", { status: 200 }));
    }
    if (url.includes("/files/fil_doc/commit")) {
      return Promise.resolve(
        Response.json({
          code: 200,
          msg: "",
          request_id: "req_2",
          data: {
            fileId: "fil_doc",
            status: "ready",
            bytes: 9,
            contentType: seen.declared,
            sha256: "b".repeat(64),
            uri: "spicy://f/fil_doc",
            expiresAt: "2026-10-06T00:00:00Z",
          },
        }),
      );
    }
    return Promise.resolve(Response.json({ code: 500, msg: "unexpected" }, { status: 500 }));
  };
}

void test("reference documents upload with their type named on this side, because the SDK cannot infer it", async () => {
  // The service has taken PDF, Office, iWork, TXT and Markdown since 2026-09-29, for fields such as
  // reference_file_url. The SDK infers only eight media types, and this tool's own enum stopped at
  // the same eight, so an agent asked to "use this brief.pdf" had no way to upload it at all.
  const cases: Array<[string, string]> = [
    ["brief.PDF", "application/pdf"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["slides.key", "application/vnd.apple.keynote"],
    ["script.txt", "text/plain"],
    ["voice.mp3", "audio/mpeg"],
  ];
  for (const [name, expected] of cases) {
    const path = await tempFile(name, "%PDF-1.7\n");
    process.env.SPICY_MCP_UPLOAD_ROOTS = workspace!;
    const seen: { declared?: string; put?: boolean; tickets: number } = { tickets: 0 };
    const connection = await connect(echoingStub(seen));
    try {
      const result = await connection.client.callTool({
        name: "spicyapi_upload_file",
        arguments: { path },
      });
      assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.content)}`);
      assert.equal(seen.declared, expected, `${name} was declared with the wrong type`);
      assert.equal(seen.put, true, `${name}: the bytes must genuinely be PUT`);
      const uploaded = (result.structuredContent as { result?: { uri?: string; contentType?: string } })
        .result;
      assert.equal(uploaded?.uri, "spicy://f/fil_doc");
      assert.equal(uploaded?.contentType, expected);
    } finally {
      await connection.close();
      delete process.env.SPICY_MCP_UPLOAD_ROOTS;
    }
  }
});

void test("an unrecognised extension is refused before any request, naming documents among the options", async () => {
  const path = await tempFile("archive.xyz", "bytes");
  process.env.SPICY_MCP_UPLOAD_ROOTS = workspace!;
  const seen: { declared?: string; put?: boolean; tickets: number } = { tickets: 0 };
  const connection = await connect(echoingStub(seen));
  try {
    const result = await connection.client.callTool({
      name: "spicyapi_upload_file",
      arguments: { path },
    });
    assert.equal(result.isError, true);
    assert.equal(seen.tickets, 0, "no ticket may be requested for a file whose type is unknown");
    const text = JSON.stringify(result.content);
    for (const extension of ["png", "mp4", "wav", "pdf", "pptx", "md"]) {
      assert.match(text, new RegExp(`\\b${extension}\\b`), `${extension} is missing from the list`);
    }

    // An explicit contentType still wins, documents included.
    const explicit = await connection.client.callTool({
      name: "spicyapi_upload_file",
      arguments: { path, contentType: "text/markdown" },
    });
    assert.equal(explicit.isError, undefined, JSON.stringify(explicit.content));
    assert.equal(seen.declared, "text/markdown");
  } finally {
    await connection.close();
    delete process.env.SPICY_MCP_UPLOAD_ROOTS;
  }
});

void test("the upload tool accepts every content type the bundled contract lists", async () => {
  // The bundled contract arrives with each SDK release, so this goes red on the first upgrade that
  // adds an upload type the tool's enum does not know - the gap that kept documents out.
  const contract = await readOpenApiContract();
  const block = /UploadURLRequest:[\s\S]*?contentType: \{[^}]*enum: \[([^\]]+)\]/.exec(contract);
  assert.ok(block?.[1], "UploadURLRequest.contentType enum not found in the bundled contract");
  const listed = block[1].split(",").map((value) => value.trim());
  assert.ok(listed.includes("image/png"), "the parsed enum is not the upload one");
  for (const contentType of listed) {
    assert.ok(
      (UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType),
      `the contract accepts ${contentType} but spicyapi_upload_file refuses it`,
    );
  }
});
