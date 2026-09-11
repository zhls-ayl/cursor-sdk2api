# Request lifecycle live verification — 2026-09-11

Explicit user authorization covered one supplied Cursor API Key, real inference,
and local fixes. The Key was supplied through echo-disabled process stdin and
kept in memory. It was not stored in shell arguments, environment files, managed
accounts, source, or receipts. Existing `.env` and private repository state were
not used or changed. No deployment, publication, or push occurred.

Environment: macOS arm64, Node 26.8.2, official `@cursor/sdk` 1.0.30, BYOK,
loopback HTTP, isolated temporary state/workspace, configured outbound proxy
(`http1-proxy` Agent transport and `undici-proxy` fetch). Selected live catalog
model: `composer-2.5`. Ambient tools and hosted search remained disabled.

## Business checks

The initial run used commit `895cc27`. Disposal and redaction changes were then
checked against the edited source/runtime. Requests used short synthetic text
and a client-side tool with no external side effects. Only booleans, counts,
status, numeric usage, and timing were retained.

| Check | Observed result |
| --- | --- |
| Authenticated catalog | Nonempty catalog in 4,856 ms. Another fresh instance exceeded the 5,000 ms catalog budget and returned `200` with an unavailable empty list; later refresh recovered in 1,730 ms. |
| Messages non-stream | HTTP 200, exact random marker, `end_turn`, 12,402 ms. |
| Ordinary successor over SSE | HTTP 200, exact next marker, trace `exact_successor_live`, current-turn Send length 51 characters, 4,925 ms; one `message_start`, one `message_stop`, three text deltas. |
| Ordinary duplicate replay | Same reconstructed response, 39 ms, no additional ordinary trace action. |
| Tool continuation over SSE | One `live_alpha` call; returned random tool-result marker reproduced exactly, with no further tool call. Duplicate result submission returned the same reconstructed response in 37 ms. |
| Tool rerun after helper fix | Streamed `token=CHECK` argument confirmed; continuation exact marker, 7,341 ms; duplicate identical response, 45 ms. |
| Three simultaneous requests | Two correct HTTP 200 responses (14,691 / 16,259 ms); third HTTP 429 `rate_limited` in 189 ms. This verifies gateway per-Key admission at 2, not a Cursor service limit. |
| Chat Completions SSE | HTTP 200, expected marker, `[DONE]`, 14,752 ms. |
| Responses SSE | HTTP 200, expected marker, `response.completed`, 12,171 ms. |

The tool-input assertion initially failed because the live client reconstructed
text/thinking deltas but ignored `input_json_delta`. The actual protocol carried
the input; reconstructing partial JSON and rerunning proved the argument. This
was a test-client defect, not missing gateway tool arguments.

These timings are individual observations, not latency percentiles. First local
SSE write is not model TTFT. Replay response equality plus ordinary trace was
checked; this run did not independently audit billing receipts or upstream
charges for duplicate tool results.

## Controlled startup interruption

A real SDK Agent/Run was used with a local gate delaying delivery of the returned
Run to the driver. This deliberately injected delay is not a naturally observed
Cursor startup timeout. The first pass used a 30-second startup budget:

- Real SDK Send returned before the gate was released.
- HTTP returned 504; the identical retry returned 504 and a different payload
  returned 429. Exactly one Agent create and one Send had occurred.
- Agent disposal had not begun while Send delivery was held.
- Releasing the gate produced `cancel` → confirmed terminal `finished` → awaited
  disposal, in order. The model had already finished by this pass's cancellation.
- A new request then returned HTTP 200 with the exact recovery marker.

A second pass against the final edited source shortened only the first startup
timer to 5 seconds and again held Run delivery. This reached a real in-flight
cancellation: HTTP 504 at 9,025 ms from probe start, driver received the Run at
9,100 ms, cancel acknowledged at 9,128 ms, terminal `cancelled` confirmed at
9,133 ms, and asynchronous disposal completed at 10,599 ms. Thus `cancel()`
return preceded complete disposal by about 1.47 seconds. Retries remained gated
and a subsequent request returned the exact recovery marker with HTTP 200.
The earlier time before Agent creation includes the separate catalog request.

The startup driver now preserves this order even if cancellation fails, registry
sweep/drain closes the Session, or an ordinary Send error is followed by slow or
failed disposal. Contract/integration regressions cover those forced failures.

## Fixes prompted by this verification

- Redact bare `crsr_` credentials in production errors/log fields and live
  receipts; use one shared redactor plus exact-canary protection.
- Await SDK asynchronous disposal, terminal confirmation, and protected cleanup
  settlement before releasing interrupted startup admission. Capture asynchronous
  registry cleanup failures.
- Return HTTP 503 with an error envelope when no catalog is available, retaining
  diagnostic fields. Valid stale data and successful empty catalogs remain 200.
  The default timeout was not raised based on a few samples.
- Reconstruct SSE tool input JSON in the live test client.
- Wait for actual child process closure before deleting live test state,
  including SIGINT/SIGTERM and forced termination paths.

Exact-Key scans of the completed live runs' temporary state and workspaces found
no occurrence before directory removal. No prompt, Key, tool result, SDK Agent
ID, account identity, or raw SDK log is retained in this evidence.

Final local validation: server/web typecheck, 56 test files / 422 tests, and
server/web build passed. Live requests used the existing proxy environment;
these results do not establish performance on a direct connection.
The same repository gitleaks check passed on the tracked/unignored source export.
The complete workspace scan still reported 17 findings across eight existing
Git-ignored private files; it is not claimed clean. The supplied test Key was
not among persisted test artifacts. Temporary scanners and live probe processes
were removed/stopped after verification.

Managed-account routing, cross-account failover, sustained load, all catalog
models, restart/cold recovery, and production deployment were outside this live
sample. Their local tests do not establish live behavior for those paths.
