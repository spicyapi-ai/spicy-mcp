# @spicyapi/mcp

The official local MCP server for [SpicyAPI](https://spicyapi.ai). It lets the AI assistant you
already use — Claude Desktop, Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI or any MCP
client — browse the live model catalog, compare prices, create generation tasks and collect results,
with every billable step confirmed by you.

SpicyAPI is an unrestricted AI API: one key for 200+ image, video, audio and chat models (Seedance,
Kling, Wan, MiniMax, Seedream, GPT Image, Suno and more), with no content filter added by the
platform. What a request can produce depends on the model you pick, and the catalog marks which
models are uncensored.

This package installs `spicyapi-mcp` (stdio) and `spicyapi-mcp-http` (loopback-only Streamable
HTTP). It does **not** contain the CLI or the Agent Skill.

Full, beginner-friendly guide: **[docs.spicyapi.ai/docs/mcp](https://docs.spicyapi.ai/docs/mcp)**.

## What it does, in plain words

MCP (Model Context Protocol) is an open standard for giving AI assistants extra abilities. Once this
server is added to your assistant, you can ask in ordinary language — _"make a five-second video
from this photo"_ — and the assistant:

1. finds a suitable model in the live catalog and reads what it accepts;
2. uploads your local file if there is one;
3. gets an exact USD quote and **stops to ask you** before anything is charged;
4. starts the task, waits for it and gives you the result link.

The server runs on your own computer. Your assistant app starts it when needed; there is nothing to
host.

## Requirements

- **Node.js 22.13 or later** (`node --version`). `npx` ships with Node.js.
- **A SpicyAPI API key** (below), and funds on the account for paid tasks. Browsing, quoting and
  reading results are free.
- **An MCP client.** Creating, retrying and purging tasks additionally require a client that
  supports MCP form **elicitation** (the protocol's way of asking the user a question). In a client
  without it those three tools return an error, usually containing
  `did not declare the required capability`. Nothing is created, reserved, charged or destroyed:
  creation has fetched only its free quote by then, and retry and purge have sent no request. The
  read-only tools still work.

## Get a key first

1. Create an account at [spicyapi.ai/register](https://spicyapi.ai/register) — if sign-ups are
   paused, that page shows how to join the waitlist.
2. On the [API keys page](https://spicyapi.ai/console/keys) choose **Create key**. Name it after the
   assistant that will use it. Under **Advanced** you can set a daily cap, monthly budget, lifetime
   cap, allowed models, IP allowlist and expiry; new keys always get the platform's default daily
   cap unless you enter `0` for no cap.
3. Copy the key. It starts with `sk-spicy-` and is shown once.
4. For the terminal-based setups below, export it in the terminal you will run the setup command
   from:

```bash
export SPICY_API_KEY="sk-spicy-..."   # paste your own key
```

In Windows PowerShell: `$env:SPICY_API_KEY = "sk-spicy-..."`.

## Add it to your client

Every client below runs the same stdio server: `npx --yes --package=@spicyapi/mcp spicyapi-mcp`.

You never run this server yourself — your MCP client starts it. Launched by hand it just waits
silently on stdin, which looks like a hang. And it needs `--package=@spicyapi/mcp` in front of the
binary name, because this package ships two of them; plain `npx @spicyapi/mcp` fails with
`could not determine executable to run`.

### Claude Desktop

1. Open **Settings → Developer → Edit Config**. The file is
   `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
   `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
2. Paste the block below (or add the `spicyapi` entry to an existing `mcpServers`) and replace
   `YOUR_SPICY_API_KEY`.
3. Quit Claude Desktop completely and reopen it — it reads this file only at launch.

```json
{
  "mcpServers": {
    "spicyapi": {
      "command": "npx",
      "args": ["--yes", "--package=@spicyapi/mcp", "spicyapi-mcp"],
      "env": { "SPICY_API_KEY": "YOUR_SPICY_API_KEY" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add spicyapi \
  -e SPICY_API_KEY=$SPICY_API_KEY \
  -- npx --yes --package=@spicyapi/mcp spicyapi-mcp
```

The default scope is the current project; add `--scope user` for every project. Do not use
`--scope project`, which writes the key into a `.mcp.json` inside the repository. Check with
`claude mcp list` or `/mcp`. On native Windows, if the server fails to start, use
`-- cmd /c npx --yes --package=@spicyapi/mcp spicyapi-mcp`.

### Codex

```bash
codex mcp add spicyapi \
  --env SPICY_API_KEY=$SPICY_API_KEY \
  -- npx --yes --package=@spicyapi/mcp spicyapi-mcp
```

That writes `~/.codex/config.toml`, which the Codex CLI, the IDE extension and the ChatGPT desktop
app all read — configure it once and all three pick it up. Check with `codex mcp list` or `/mcp`.

Both terminal commands copy `SPICY_API_KEY` out of your current shell into that client's local
config, so run them in a terminal where the key is already exported. If it was not, remove the
server (`claude mcp remove spicyapi` / `codex mcp remove spicyapi`) and add it again.

### Cursor, Windsurf and Gemini CLI

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`) and **Gemini
CLI** (`~/.gemini/settings.json`) share the same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "spicyapi": {
      "command": "npx",
      "args": ["--yes", "--package=@spicyapi/mcp", "spicyapi-mcp"],
      "env": { "SPICY_API_KEY": "YOUR_SPICY_API_KEY" }
    }
  }
}
```

On Windows these live under `%USERPROFILE%`. If a file already has other settings, merge
`mcpServers` into it — the whole file must stay valid JSON, with no comments or trailing commas.
Restart the client if the tools do not appear (Gemini CLI: `/mcp` lists them).

Those are user-level files outside your repository. Never copy that block, with a real key in it,
into a project file that gets committed — such as a project-level `.cursor/mcp.json`.

### VS Code

`.vscode/mcp.json` is committed with your repository, so let VS Code prompt for the key and keep it
in its own secret storage:

```json
{
  "inputs": [
    {
      "id": "spicyapi-key",
      "type": "promptString",
      "description": "SpicyAPI key",
      "password": true
    }
  ],
  "servers": {
    "spicyapi": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=@spicyapi/mcp", "spicyapi-mcp"],
      "env": { "SPICY_API_KEY": "${input:spicyapi-key}" }
    }
  }
}
```

Start it from the code lens above the entry or **MCP: List Servers**, paste the key when asked, then
use the tools from Chat in Agent mode.

### Any other MCP client

Use the same `command`, `args` and `env`. Each client owns its config location and format, and both
change between versions — their own documentation is authoritative.

## Check that it works

Ask your assistant, in order:

1. _"Check the SpicyAPI service status."_ — `spicyapi_service_status` needs no key, so this proves
   the server starts.
2. _"What is my SpicyAPI balance?"_ — `spicyapi_balance_get` proves the key reaches the server.
3. _"Which SpicyAPI tools do you have?"_ — expect 15 tools prefixed `spicyapi_`.

None of these costs anything.

## Then ask for something real

> Use SpicyAPI to list the image models I can call, pick an inexpensive one, generate a cinematic
> night portrait, and give me the result link when it finishes.

The agent reads the catalog, fetches the model's schema, obtains an exact quote and stops for your
confirmation before anything is charged.

More prompts to try:

- _"How much SpicyAPI balance do I have, and what did I spend this week?"_ — balance and usage,
  free.
- _"Find SpicyAPI models that turn an image into a video and compare what a 5-second clip costs on
  each."_ — catalog plus quotes, free.
- _"Turn /Users/me/Desktop/portrait.jpg into a 5-second video with a slow push-in."_ — upload, then
  a confirmed task.
- _"Show my SpicyAPI tasks from the last three days that failed, and why."_ — task history, free; a
  retry afterwards asks for confirmation.

Model IDs always come from the live catalog. Any placeholder such as `MODEL_ID_FROM_CATALOG` in
SpicyAPI documentation means an exact ID selected from that catalog, not a literal value.

## Tools

| Tool                           | Purpose                                                         | Read-only | Billable | Confirmation |
| ------------------------------ | --------------------------------------------------------------- | --------- | -------- | ------------ |
| `spicyapi_service_status`      | Public health and readiness; no key needed                      | Yes       | No       | No           |
| `spicyapi_docs_search`         | Search the bundled first-party documentation index; no key      | Yes       | No       | No           |
| `spicyapi_models_list`         | Enabled models and account-specific prices                      | Yes       | No       | No           |
| `spicyapi_model_get`           | One model and its current input schema                          | Yes       | No       | No           |
| `spicyapi_balance_get`         | Available, held and total balance                               | Yes       | No       | No           |
| `spicyapi_usage_get`           | Settled USD usage for the current key                           | Yes       | No       | No           |
| `spicyapi_tasks_list`          | One page of task metadata for the current key                   | Yes       | No       | No           |
| `spicyapi_task_get`            | Read one task, including ready result links                     | Yes       | No       | No           |
| `spicyapi_task_wait`           | Wait up to 300 seconds for a task to reach a terminal state     | Yes       | No       | No           |
| `spicyapi_task_quote`          | Price an exact request without creating anything                | Yes       | No       | No           |
| `spicyapi_upload_file`         | Read, upload and commit a local file; return its `spicy://` URI | No        | No       | No           |
| `spicyapi_download_url_create` | Short-lived signed URL for a task output                        | No        | No       | No           |
| `spicyapi_task_create`         | Create an asynchronous generation task                          | No        | **Yes**  | **Always**   |
| `spicyapi_task_retry`          | Create a new task from a failed or expired one                  | No        | **Yes**  | **Always**   |
| `spicyapi_task_purge`          | Destroy one terminal task's stored content (`destructiveHint`)  | No        | No       | **Always**   |

The server also registers two resources — `spicyapi://docs/index` and `spicyapi://contract/openapi`
— and one prompt. `spicyapi_generation_workflow` is a **prompt**, not a tool — it is registered with
`registerPrompt`, takes `goal` and an optional `model`, and does not appear in `SPICYAPI_MCP_TOOLS`.
Hosts surface it wherever they list MCP prompts.

### Parameters

| Tool                           | Parameters (required in **bold**)                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `spicyapi_service_status`      | none                                                                                                                                       |
| `spicyapi_docs_search`         | `query` (default `""`), `limit` (1–25, default 10)                                                                                         |
| `spicyapi_models_list`         | `modality` (`image` / `video` / `audio` / `text`), `provider`, `task`, `search`, `includeSchema`, `includeExamples` (both default `false`) |
| `spicyapi_model_get`           | **`model`**                                                                                                                                |
| `spicyapi_balance_get`         | none                                                                                                                                       |
| `spicyapi_usage_get`           | `from`, `to` (`YYYY-MM-DD`, UTC)                                                                                                           |
| `spicyapi_tasks_list`          | `from`, `to`, `state`, `model`, `limit` (1–100, default 20), `cursor`                                                                      |
| `spicyapi_task_get`            | **`taskId`**                                                                                                                               |
| `spicyapi_task_wait`           | **`taskId`**, `timeoutSeconds` (1–300, default 60), `intervalSeconds` (1–60, default adaptive)                                             |
| `spicyapi_upload_file`         | **`path`** (absolute; `~/`, and `~\` on Windows, is expanded), `contentType` (only when the extension is missing or wrong)                 |
| `spicyapi_download_url_create` | **`taskId`**, `key`                                                                                                                        |
| `spicyapi_task_quote`          | **`model`**, **`input`**, `callBackUrl`                                                                                                    |
| `spicyapi_task_create`         | **`model`**, **`input`**, `callBackUrl`, `idempotencyKey`, `retentionSeconds`                                                              |
| `spicyapi_task_retry`          | **`taskId`**, `idempotencyKey`                                                                                                             |
| `spicyapi_task_purge`          | **`taskId`**                                                                                                                               |

Model input schemas are returned as plain JSON Schema: display-only and rate-card annotations are
stripped before they reach the agent.

`spicyapi_task_create` accepts an optional `retentionSeconds` that shortens how long that one task's
generated media, result payload, prompt and other input text are kept; it can never extend them, `0`
removes them once the task reaches a terminal state, and billing records are always kept.

Its optional `callBackUrl` must be a public `https://` address. Plain `http://` is refused, and so
are `localhost`, private network addresses, explicit ports other than 443 and 80, and URLs carrying
credentials; each returns `400` with `Invalid callback URL`. `http://` has no development exception
because the delivery body carries the prompt and signed links to the result.

`spicyapi_task_purge` is annotated `destructiveHint: true` and removes a terminal task's generated
media, result payload, prompt and other input text. It destroys content, not the record of what it
cost — the ledger entry, charged amount, model, state, timestamps and request ID all survive — so it
is never a refund. Only terminal tasks are accepted. An accepted task cannot be canceled and there
is no cancellation API, so for a queued or running task, wait until it finishes
(`spicyapi_task_wait`), then purge it. It takes no idempotency key, because the task ID is the
idempotency key: a repeat after a dropped response returns the original `purgedAt` and changes
nothing. Its result carries only the task ID, content state and removal metadata: no links, tickets
or output keys, because leaving a way to fetch the content in the same message that reports its
destruction would defeat the point.

## How spending is protected

Billable tools use protocol elicitation and signed request state. Task creation fetches and binds
the exact quote, then asks you to confirm its USD estimate and maximum charge. **An agent cannot
bypass that confirmation.**

- **The question goes to the user, not the model.** The client renders it; the agent has no way to
  answer it.
- **The answer is bound to the exact arguments.** If the model, input or any other argument changes
  between the question and the answer, the call fails with
  `confirmed request state does not match the current tool arguments` and nothing is created.
- **Declining creates, charges and destroys nothing.** A declined or cancelled confirmation returns
  `operation declined; …` with what did and did not happen. For task creation that is
  `no task was created and no funds were reserved or charged (only the free price quote had been requested)`
  — the quote shown in the question was already fetched. Retry and purge send no request before
  confirmation, so theirs ends in `no SpicyAPI request was made`. Leave any "auto-accept
  elicitation" setting off for this server.
- **No elicitation, no spending.** A client without form elicitation cannot answer the question, so
  creation fails right after the free quote and nothing is created or charged.
- **Quotes last five minutes.** Confirming after that fails with `40901`; ask again for a fresh
  quote.
- **Retry confirmations carry no price.** A retry is a new task at the model's current price; use
  `spicyapi_task_quote` first if you want the number.
- **Recovery reuses the idempotency key.** The confirmation shows it, and a failure after
  confirmation returns it with a recovery hint. Calling `spicyapi_task_create` again with that
  `idempotencyKey` and the unchanged request returns the original task instead of a second charge.
- Failed and expired tasks are never charged; the hold is released automatically. A successful task
  settles on actual usage, capped at the accepted hold. Accepted tasks cannot be cancelled.

Call creation directly once the model input is ready. The separate `spicyapi_task_quote` tool is for
independent price comparisons, not a prerequisite. Health and balance checks are optional
diagnostics, not a per-task checklist.

## Results

`spicyapi_task_get`, `spicyapi_task_wait` and verified v2 webhooks all include ready
`output.assets[].url` links. Use them directly — never send the API key to storage. A complete
verified callback needs no extra task lookup and no download ticket. Query again for `pending`
assets or expired links; `spicyapi_download_url_create` remains available for legacy integrations
and explicit link renewal, and its signed URL lasts 20 minutes.

Some models answer in `output.text` rather than with a file — audio transcription is the plain case,
an ordinary asynchronous task whose result is words. An empty `output.assets` on such a model is the
expected shape, not a failure, so report the text instead of looking for a missing link. A
transcription may also carry `output.transcript` with word timings and the detected language, and
layer decomposition returns one image per layer, stacked by `output.assets[].layer.zIndex`.

`spicyapi_task_wait` polls adaptively by default, starting at about two seconds and backing off to
at most ten. Set `intervalSeconds` only for a fixed interval. Waiting is bounded to 60 seconds by
default and 300 at most per call; a local timeout does not cancel the accepted task.

Generated artefacts are kept for about 14 days at most, prompts for 30 days, uploads for one day —
see [Retention and destruction](https://docs.spicyapi.ai/docs/retention). Copy anything you want to
keep.

## Usage reports

`spicyapi_usage_get` takes optional `from` and `to` dates in `YYYY-MM-DD`. It queries only the API
key configured for this MCP process — there is no user, key or workspace override.

- UTC range `[from,to)`, up to 92 days. By default `to` is tomorrow UTC and `from` is seven days
  earlier.
- Task counts are grouped by creation day and model.
- `totalSpend` and each `spend` are exact decimal USD strings covering settled charges only; pending
  holds are excluded and late settlement can change earlier days.
- This is a usage report, not account balance or remaining key budget, and is never required before
  generating. Observe `Retry-After` when reporting is rate limited.

`spicyapi_tasks_list` finds tasks after a restart or a missed callback. It returns one page of
metadata with no inputs, no result URLs and no automatic detail requests. Filters: `from`, `to`,
`state`, `model`, `limit`, `cursor`. Keep the UTC dates fixed while paging and pass `nextCursor`
unchanged. Default window seven days ending tomorrow UTC, 92 days maximum; page size 20, capped
at 100. `cost` is final only when `settled` is true. Do not use history for status polling or as a
prerequisite to generation.

This endpoint has its own account-wide bucket: a burst of 30 requests, refilling 30 per minute,
shared by every key on the account. Unlike the general API limit it fails closed, so it still
rejects when the limiter is degraded. Use it for reconciliation, not polling.

## Local files

`spicyapi_upload_file` takes the absolute path the user gave, reads the file, uploads the bytes from
this machine and commits the upload in one call, then returns the committed `spicy://` URI to put in
a model input field. There is no separate commit tool: nothing on the MCP side ever holds a
half-finished upload. Split-step uploads (ticket, `PUT`, commit) belong to SDK code, which finishes
them with `commitUploadedFile`. Images (JPEG, PNG, WebP, GIF) up to 10 MiB; MP4 / WebM video and MP3
/ WAV audio up to 90 MiB; reference documents up to 90 MiB — PDF, Word, Excel, PowerPoint, Keynote,
Pages, Numbers, plain text and Markdown — for fields such as `reference_file_url`. Content type is
inferred from the extension. Public HTTPS media URLs need no upload. Relative paths are refused; a
leading `~/` (and `~\` on Windows) is expanded to the home directory. If the extension is not
recognised, nothing is uploaded and the error lists every extension the tool infers: `gif`, `jpeg`,
`jpg`, `png`, `webp`, `mp4`, `webm`, `mp3`, `wav`, `pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`,
`pptx`, `key`, `pages`, `numbers`, `txt`, `md`, `markdown`.

The server reads only under the user's home directory. Symlinks are resolved before the check, so a
link pointing out of an allowed root is refused. The guard exists for prompt injection — a path that
arrives inside an email, a web page or a task description is data, not an instruction — not to
restrict the person running the server, who can already read their own files.

Set `SPICY_MCP_UPLOAD_ROOTS` in the server's `env` to narrow or widen that; it replaces the default.
Entries are separated like `PATH`: `:` on macOS and Linux, `;` on Windows. `~` is **not** expanded
in this variable, so write full paths.

```json
{
  "env": {
    "SPICY_API_KEY": "YOUR_SPICY_API_KEY",
    "SPICY_MCP_UPLOAD_ROOTS": "/Users/you/Pictures:/Users/you/Movies"
  }
}
```

On Windows the same entry reads `"SPICY_MCP_UPLOAD_ROOTS": "C:\\Users\\you\\Pictures;D:\\Renders"`
(backslashes doubled inside JSON). A root that does not exist matches nothing; the refusal message
lists the roots in effect.

## Environment variables

| Variable                 | Used by             | Meaning                                                                                                 |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `SPICY_API_KEY`          | both entrypoints    | Your API key. Required for everything except status and docs search                                     |
| `SPICY_MCP_UPLOAD_ROOTS` | both entrypoints    | Directories `spicyapi_upload_file` may read, separated by `:` (`;` on Windows). Default: home directory |
| `SPICY_MCP_HTTP_TOKEN`   | `spicyapi-mcp-http` | Required bearer token, at least 32 bytes, different from `SPICY_API_KEY`                                |
| `SPICY_MCP_HOST`         | `spicyapi-mcp-http` | `127.0.0.1` (default), `localhost` or `::1`; anything else is refused                                   |
| `SPICY_MCP_PORT`         | `spicyapi-mcp-http` | Port, default `8765`                                                                                    |
| `HTTPS_PROXY`            | both entrypoints    | Send API calls through this proxy; see [Behind a proxy](#behind-a-proxy)                                |

## Behind a proxy

If your network reaches the internet through an HTTP proxy, put `HTTPS_PROXY` (and `NO_PROXY`, if
you need it) in the server's `env` block. The server uses it on its own on Node.js 22.21+ or 24+.
Node.js's built-in `fetch` ignores proxy variables unless it was started with
`NODE_USE_ENV_PROXY=1`, so when the server finds an `http://` or `https://` proxy it restarts itself
once with that switch on. Set `NODE_USE_ENV_PROXY=0` to always connect directly.

Put it in the `env` block rather than relying on your shell. Desktop apps do not see the variables
you export in a terminal, and Codex passes only a short fixed list of them to MCP servers:

```bash
codex mcp add spicyapi \
  --env SPICY_API_KEY=$SPICY_API_KEY \
  --env HTTPS_PROXY=http://127.0.0.1:7890 \
  -- npx --yes --package=@spicyapi/mcp spicyapi-mcp
```

A proxy that `curl` in your terminal uses and this server does not is the usual reason `curl`
reaches the API while the server reports `network request failed`. Errors then say so: they name
the proxy variable that was set and not used. `socks5://` proxies are not supported.

## HTTP entrypoint

`spicyapi-mcp-http` serves Streamable HTTP on loopback only. Most users want the stdio entrypoint
above instead; use this for a client that connects to an already-running server by URL.

```bash
export SPICY_API_KEY="sk-spicy-..."
export SPICY_MCP_HTTP_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
npx --yes --package=@spicyapi/mcp spicyapi-mcp-http
# SpicyAPI MCP HTTP listening at http://127.0.0.1:8765/mcp
```

- The MCP endpoint is `/mcp` and requires `Authorization: Bearer <SPICY_MCP_HTTP_TOKEN>`; without it
  the server answers `401`.
- `GET /healthz` returns `{"ok":true}` without authentication.
- It refuses to start on a non-loopback address, with a token shorter than 32 bytes, or with a token
  equal to `SPICY_API_KEY`.
- Host and Origin headers must be local, so web pages on other sites cannot drive it; request bodies
  are capped at 2 MiB.

Loopback means only programs on the same computer can connect — not other devices on the network.

## Troubleshooting

| Symptom                                                                  | Fix                                                                                                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| No SpicyAPI tools in the client                                          | Restart the client fully; validate the JSON (no comments or trailing commas); check the file path; check `node --version` is 22.13 or later           |
| `npx: command not found` / `spawn npx ENOENT`                            | Install Node.js from nodejs.org, or use the absolute path from `which npx` / `where npx`; on Windows try `"command": "cmd"` with `/c npx …` args      |
| `could not determine executable to run`                                  | Add `--package=@spicyapi/mcp` before `spicyapi-mcp`                                                                                                   |
| `SPICY_API_KEY is required for authenticated API operations`             | The key is not reaching the server: fix the `env` block, or re-add the server from a shell where the key is exported                                  |
| `HTTPS_PROXY is set, but this request did not use it`                    | Update Node.js to 22.21+ or 24+, or add `NODE_USE_ENV_PROXY=1` to the `env` block; see [Behind a proxy](#behind-a-proxy)                              |
| `401`                                                                    | Key mistyped, revoked or expired — create a new key                                                                                                   |
| `40201` / `40202` / `40301`                                              | Top up; raise the key's cap or wait for the UTC reset; allow the model on the key                                                                     |
| `40310`                                                                  | Verify your account email: open the link we sent, or send a new one from the console                                                                  |
| `40003`                                                                  | The uploaded bytes do not match their ticket; call `spicyapi_upload_file` again and use the new `spicy://` URI                                        |
| `40004`                                                                  | No deployment can serve that exact combination of settings; change the parameter named in the message against the model's schema, do not just retry   |
| `503`                                                                    | A dependency is briefly unavailable; wait for `Retry-After`, then repeat the call                                                                     |
| `50302`                                                                  | A synchronous generation failed upstream and was already refunded; sending the same request again is safe                                             |
| `did not declare the required capability`                                | The client lacks elicitation support; nothing was created or charged (creation fetched only its free quote). Update it, or use the CLI for paid tasks |
| `confirmed request state does not match the current tool arguments`      | The request changed after the question was asked; start the creation again                                                                            |
| `40901`                                                                  | Quote expired or price changed; quote and confirm again                                                                                               |
| `path must be absolute` / `no such file` / `may only read files under …` | Give the full path; check it exists; move the file under an allowed root                                                                              |
| `cannot tell the file type from its extension; …`                        | Rename the file with a listed extension, or pass `contentType`                                                                                        |
| `operation declined; …`                                                  | The confirmation was declined or cancelled; the message says whether only the free quote had been requested                                           |
| `task … did not reach a terminal state within …`                         | The task is still running — wait again or look it up later; it was not cancelled                                                                      |

Errors from the API carry `status`, `code` and `requestId`; keep the request ID for support. See
[Errors](https://docs.spicyapi.ai/docs/errors) for every code.

A failed task is different from a failed call: it comes back with `state: "failed"`, an `errorCode`
from a closed set, and an `errorMessage`. Relay `errorMessage` to the user — when the model service
gave a specific reason it is passed through in English, untranslated, with service names, hosts,
URLs, request and task IDs and account details removed — but branch only on `errorCode`, which does
not change with the wording or the language.

## What this server does not do

It submits and tracks native asynchronous tasks; it does not stream chat tokens, and it has no chat
tool to add. The catalogue's text models are served by the compatible layers instead —
`POST /v1/chat/completions` and `POST /v1/responses` (OpenAI), `POST /v1/messages` (Anthropic) and
`POST /v1beta/models/{model}:generateContent` (Google Gemini), all under `https://api.spicyapi.ai` —
so a client that already speaks one of those protocols only needs its base URL pointed at SpicyAPI.
Use native `jobs/stream` when you need quote confirmation and the platform event envelope — see the
[chat streaming guide](https://docs.spicyapi.ai/docs/quotes-and-compatibility).

Text models that read images, video or audio take them as message parts, and the `spicy://f/…` URI
from `spicyapi_upload_file` is what goes in an `image_url`, `video_url` or `audio_url` part (video
and audio parts are carried by Chat Completions and `jobs/stream`) — see
[sending media to a text model](https://docs.spicyapi.ai/docs/text-and-streaming#media-input).

It cannot cancel an accepted task — no public API can — and it never answers a billing confirmation
on your behalf.

## More

- [MCP guide: setup, every tool, costs and troubleshooting](https://docs.spicyapi.ai/docs/mcp)
- [Client setup on the developer hub](https://spicyapi.ai/developers#agents)
- [Agents and automation guide](https://docs.spicyapi.ai/docs/agents)
- Want the agent to also know the _correct workflow_? Add
  [`@spicyapi/skill`](https://www.npmjs.com/package/@spicyapi/skill).
