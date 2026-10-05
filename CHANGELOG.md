# @spicyapi/mcp

## 0.5.0

### Minor Changes

- `spicyapi_upload_file` takes reference documents: PDF, Word (`doc`, `docx`), Excel (`xls`,
  `xlsx`), PowerPoint (`ppt`, `pptx`), Keynote, Pages, Numbers, plain text and Markdown, up to
  90 MiB, for input fields such as `reference_file_url`. The service has accepted them since late
  September, but the tool's `contentType` enum and the SDK's extension table stopped at eight media
  types, so an agent asked to use a PDF had no way to upload it. The type is inferred from the
  extension on this side; an unrecognised extension is refused before any request, with a message
  that lists every extension the tool understands. The uploaded file's `contentType` in the result
  is now an open string, so a type the service adds later cannot turn a finished upload into an
  error.

### Patch Changes

- Fix `spicyapi_models_list` and `spicyapi_model_get` failing with `Output validation error` once
  the catalogue included speech models billed per thousand characters. The output schema pinned
  `pricing[].unit` to four values, and `per_1k_characters` made the MCP SDK reject the whole result:
  every unfiltered listing, `modality: "audio"`, `task: "text-to-speech"`, and `model_get` on any of
  those models. The field is now an open string that names the known units, the same treatment
  `policyTier` received in 0.4.1.
- `spicyapi_task_get` and `spicyapi_task_wait` say where non-file results live: `output.text` for
  speech-to-text and other text answers, `output.transcript` for word timings, and one image per
  layer ordered by `output.assets[].layer.zIndex` for layer decomposition.
- The `spicyapi_tasks_list` output schema lists the optional `requestId` the service now returns.
- README: note that a `spicy://f/…` URI from `spicyapi_upload_file` is what goes in a text model's
  `image_url`, `video_url` or `audio_url` message part on the compatible endpoints.

## 0.4.6

### Patch Changes

- Honor `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` in both entrypoints. Node.js's built-in `fetch`
  ignores them unless the process starts with `NODE_USE_ENV_PROXY=1`, and nothing can switch that
  on afterwards, so a client whose shell reached the API through a proxy saw every tool call go out
  directly and fail. On Node.js 22.21+ or 24+, when a proxy variable holds an `http://` or
  `https://` URL, the server now restarts itself once with the switch on. The restarted process
  shares stdin, stdout and stderr, so stdio clients talk to it unchanged, and `SIGINT`, `SIGTERM`
  and `SIGHUP` are forwarded so stopping the server stops both. `NODE_USE_ENV_PROXY=0` opts out. A
  `socks5://` or bare `host:port` value is left alone, because Node.js refuses to start with it
  once the switch is on.
- Document proxy setup, including that Codex passes only a short fixed list of environment
  variables to MCP servers, so `HTTPS_PROXY` belongs in the server's `env`. Add `40310` (account
  email not verified yet) to the troubleshooting table.

## 0.4.2

### Patch Changes

- Make `service_status` explain the two statuses that look like outages and are not.

  `/readyz` answers 404 on the public surface **by design** — readiness reveals database and Redis
  state, so the server registers that probe only on its admin process. `operational` has always
  accounted for this, but the reasoning lived in a source comment, so anyone reading the raw
  structure saw `readiness.ok: false` next to `operational: true` and reasonably concluded something
  was broken. The explanation now travels with the output: it is in the MCP output schema and the
  tool description, and in the SDK's own type documentation. A genuine not-ready answer is 503.

  A 403 or 451 is a rejection of where the request came from — a proxy, a gateway, or a region the
  service is not offered in — and the CLI used to report it as `SpicyAPI is not healthy` and point
  at the status page, which shows everything green. It now says the request was refused, names what
  to check, and drops the status-page link.

- Updated dependencies
  - @spicyapi/sdk@0.7.0

## 0.4.1

### Patch Changes

- Fix `spicyapi_models_list` and `spicyapi_model_get` failing outright on 16 of the 121 published
  endpoints. The MCP output schema pinned `policyTier` to three values while the service already
  returns five; `softened` and `filtered` made the MCP SDK reject the structured content, so any
  unfiltered catalogue listing raised `Output validation error` rather than returning models. The
  field is now an open set, because a descriptive classification should never be able to fail a
  call.

  Catch the bundled contract up with the service. New: the anonymous evaluation catalogue
  `GET /console/v1/catalog/models`, which answers "which models are there and what do they cost"
  without an API key; business codes `40003` (uploaded bytes do not match their ticket), `40004` (no
  deployment serves that parameter combination), `503` (dependency briefly unavailable) and `50302`
  (a synchronous generation failed upstream and was already refunded); `toolkit`, marking the models
  that replace a person in an image or a video; per-tier `variants` alongside each price.
  `callBackUrl` now rejects `http://`, task `errorMessage` carries the model service's own reason in
  English when there is one, and `jobs/purge` reads no `Idempotency-Key` — `taskId` is the key.

  Document the subject-swap two-step video workflow, block-rounded duration billing, and where text
  models live: the SDK, CLI and MCP server cover asynchronous media tasks, while chat runs through
  the OpenAI, Anthropic and Gemini compatible layers with an existing client.

- Updated dependencies
  - @spicyapi/sdk@0.6.0

## 0.4.0

### Minor Changes

- Remove `spicyapi_upload_commit`. The server stopped issuing upload tickets to MCP clients long
  ago, so there was no path to a file that had been uploaded but not committed;
  `spicyapi_upload_file` reads, uploads and commits in one call. Clients that listed tools now
  see 15.
- `SPICY_MCP_UPLOAD_ROOTS` is split with the platform path separator (`:` on macOS and Linux, `;` on
  Windows), so Windows paths such as `C:\Users\me\Pictures` work. A `~\` prefix in a file path is
  expanded on Windows.

### Patch Changes

- `spicyapi_task_purge` describes the real rule: only a task in a terminal state can be purged, and
  there is no cancellation API, so wait for a queued or running task to finish first. The server
  instructions and `retentionSeconds` now state the full deletion scope.
- Declining a confirmation now reports what actually happened: declining a new task says a free
  quote was fetched but no task was created and nothing was held or charged; declining a retry or a
  purge sends no request at all. `spicyapi_task_create` notes that it needs a client with form
  elicitation.
- Updated dependencies
  - @spicyapi/sdk@0.5.2

## 0.3.1

### Patch Changes

- Stop reporting a healthy platform as down. `probeStatus` treated a 404 from `/readyz` as "not
  ready", but the readiness probe exposes database and Redis state, so the server registers it only
  on the management process — the public one never had it. `operational` was therefore always false
  on the production domain, and that is the answer to the first command the README recommends, the
  only one that needs no key and costs nothing. A genuine outage still surfaces: an unready service
  answers 503, not 404.

  `spicyapi status` now prints one line a person can read, and keeps the previous structure behind
  `--json`. CLI failures append a `Next:` line saying what to do — for 401 it distinguishes no key
  set, a key whose prefix is not `sk-spicy-`, and a key that the server rejected, echoing only the
  first nine characters.

  Documentation: the README example points at an endpoint that is live and priced instead of a
  paused one, and the MCP setup covers Claude Desktop alongside the other clients.

- Updated dependencies
  - @spicyapi/sdk@0.5.1

## 0.3.0

### Minor Changes

- a096fff: Add `spicyapi_upload_file` so an MCP client can upload a file from the user's machine and
  get back the `spicy://` URI to put in model input. The previous `spicyapi_upload_prepare` handed a
  presigned PUT ticket to the model and nothing ever sent that PUT — MCP tool results are content
  for the model to read, not requests the host executes — so local media was unreachable from MCP
  alone. It also placed the storage URL, which carries account and tenant identifiers, into the
  model context; that tool is removed. File reads are confined to the user's home directory by
  default, configurable with `SPICY_MCP_UPLOAD_ROOTS`.

  The CLI now accepts MP4/WebM video and MP3/WAV audio for `--content-type`; its whitelist had only
  the four image types while the server and SDK already took audio and video.

- 983dd22: Add customer-controlled retention and on-demand content destruction across all four
  surfaces.

  `createTask` (and `run`) accept `retentionSeconds`, sent as `X-Spicy-Retention`, to shorten how
  long one task's outputs and prompt are kept; `0` removes the outputs as soon as the task reaches a
  terminal state. It can only shorten — the account settings and the platform maximum still apply,
  and the deadlines that actually took effect come back in the task record's new `retention` object.
  An oversized value is clamped by the server rather than rejected, so a request asking to be more
  conservative never fails the generation.

  `purgeTask` destroys one terminal task's generated media, result payload, prompt and input text,
  and is idempotent. It destroys content, not the record of what it cost: the ledger entry, charged
  amount, model, state, timestamps and request ID all remain queryable, so it is never a refund.
  Task records now carry `contentState`, which distinguishes `expired` (the retention rules ran)
  from `purged` (the account destroyed it deliberately) — reporting the second as the first makes it
  look like the platform lost the customer's work.

  The CLI adds `tasks purge`, gated behind the same interactive confirmation or `--yes` as a
  billable command, and `tasks create --retention` accepting `30m`, `1h`, `7d` or plain seconds.
  `tasks get` now spells out the content state and retention deadlines in its human-readable output.

  The MCP server adds `spicyapi_task_purge` with `destructiveHint: true` and a confirmation round.
  Its result is projected onto a fixed whitelist — task ID, content state, removal metadata — so no
  link, ticket or output key can travel in the same message that reports the content's destruction.

### Patch Changes

- 4c586b6: Correct three things the package documentation had wrong. Public model IDs read
  `<publisher>/<model>/<task>` — `bytedance/seedream-5.0-pro/text-to-image` — not the internal
  `<family>/<version>/<task>` slug; the Skill's own workflow reference used the internal shape as
  its placeholder, so an agent reading it would assemble identifiers that do not resolve. There are
  no audio models: the catalog is video, image and chat, and every README opened by claiming
  otherwise. And the quickstarts could not be run as written, because both the model ID and the API
  key were placeholders with no command next to them for obtaining a real one.

  Every README now starts from getting a key (`spicyapi.ai/register`, then the console; keys begin
  `sk-spicy-`) and lists a model before using one. `npx @spicyapi/cli` and `npx @spicyapi/skill` are
  documented without `--yes --package=`, which only `@spicyapi/mcp` needs — it ships two binaries,
  so the short form fails with `could not determine executable to run`. The Skill installs with
  `npx skills add https://spicyapi.ai/skill` through the installer most coding agents share, with
  the packaged installer kept as the second option. The MCP client examples no longer pin `@0.1.0`.

- 25887e3: Give uploads their own timeout. `timeoutMs` caps at 120 s, which cannot carry a 90 MiB
  file unless the connection sustains 6.3 Mbps; the request was cut mid-transfer and surfaced as a
  local timeout. `uploadTimeoutMs` defaults to 10 minutes and applies only to the leg that moves the
  bytes.

  `spicyapi_upload_file` now expands a leading `~` and reports its three refusals apart — not
  absolute, no such file, outside the allowed roots — naming the roots it will read. One shared
  message sent the model to change the folder when the real problem was an unexpanded `~`, which
  already pointed inside the allowed root.

- Updated dependencies [39e03de]
- Updated dependencies [4c586b6]
- Updated dependencies [25887e3]
- Updated dependencies [983dd22]
  - @spicyapi/sdk@0.5.0

## 0.2.3

### Patch Changes

- Clarify task waiting, balance, and request confirmation text.

## 0.2.2

### Patch Changes

- Updated dependencies
  - @spicyapi/sdk@0.4.0

## 0.2.1

### Patch Changes

- Add `spicyapi_tasks_list` for paginated current-key task metadata, with UTC date, model and state
  filters, opaque cursors, and exact USD cost strings. Read one page without extra task lookups.

- Simplify the default agent generation workflow by reusing model schemas, relying on creation's
  built-in quote confirmation, and consuming ready result URLs directly. Keep diagnostics, separate
  price comparisons, link renewal, and all billable confirmation safeguards available.

  Add a read-only MCP usage tool for the configured API key, with UTC date filters and exact settled
  USD totals by day and model.

  Let MCP waiting inherit SDK polling backoff unless the caller explicitly selects a fixed interval.

- Updated dependencies
  - @spicyapi/sdk@0.3.0

## 0.2.0

### Minor Changes

- Add request-bound task quotes and expected-cost checks, document the public compatibility
  endpoints, and unify the development workflow across the SDK, CLI, MCP, and Agent Skill.

  The SDK now enforces an end-to-end timeout and a size limit when reading response bodies, and
  fills in the OpenAI-compatible examples and regression tests. The CLI and MCP add read-only
  quoting while keeping explicit confirmation and idempotency controls for billable writes. The
  content-mode field sent by older clients is now ignored for task admission.

### Patch Changes

- Updated dependencies
  - @spicyapi/sdk@0.2.0
