# Deployment

## Local

```bash
cp .env.example .env
# Edit .env: replace the gateway key and set a persistent STATE_DIR.
chmod 600 .env
npm ci
npm run build
npm start
```

`npm start` loads `.env` when present using Node's `--env-file-if-exists`.
Already-exported environment variables take precedence. For an explicit file,
use `node --env-file=/protected/gateway.env dist/index.js`. A bare
`node dist/index.js` reads only the process environment. No credentials are
needed for the deterministic tests or build.

The immutable build includes the optional BF Labs Operator Console at
`/console/`. It is served by the same Node process from `dist/console`; no
second production service is required. Set `CONSOLE_DIR` only when an operator
intentionally supplies a different prebuilt static bundle.

Loading the page and its v0.1 management calls is unauthenticated. A Cursor key
is sent only during import and is not returned to the browser afterward; the
roster keeps only account ids and masked hints. `HOST=0.0.0.0` publishes `/v1`
and `/health` on the LAN. `/console/` and `/v0/management/*` still require a
loopback socket and ignore forwarded client IPs. An Internet-facing reverse
proxy must authenticate and restrict `/console/` and `/v0/management/*`.

## Docker

```bash
docker build -t cursor-sdk2api:local .
docker run -d --name cursor-sdk2api -p 127.0.0.1:8080:8080 \
  --env-file .env -e HOST=0.0.0.0 -e PORT=8080 -e STATE_DIR=/data \
  --restart unless-stopped --stop-timeout 3660 \
  -v cursor-sdk2api-data:/data \
  cursor-sdk2api:local
```

`docker-compose.yml` is a single-service wrapper. It does not mount files from other projects and does not ship secrets.

For managed Docker setup, set distinct `GATEWAY_ACCESS_KEY` and `CURSOR_API_KEY`
values in the protected `.env` file before starting. The Cursor key seeds the
persistent account pool; an empty pool deliberately reports not ready. Compose
publishes the protocol API on `GATEWAY_BIND` (default `0.0.0.0`); set it to
`127.0.0.1` for a host-only API.

Docker bridge port publishing does not make a host browser's socket loopback
inside the container. `/console/` and `/v0/management/*` remain inaccessible
through that mapping, even when the host port binds to `127.0.0.1`. The browser
console works with the local Node deployment above. For additional accounts in
Compose, an operator can import a key through container-local loopback without
putting it in command arguments or output:

```bash
docker compose exec -T gateway /nodejs/bin/node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const api_key = readFileSync(0, "utf8").trim();
  if (!api_key) throw new Error("Key file is empty");
  const response = await fetch("http://127.0.0.1:8080/v0/management/accounts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Account import failed: HTTP ${response.status}`);
  console.log("Account imported");
' < /protected/cursor-key
```

## Health and supervision

- `GET /livez`: HTTP 200 while the HTTP process is responsive, including during
  drain and initial account setup. Docker uses this liveness check.
- `GET /health`: HTTP 200 when locally ready for new sessions; HTTP 503 and
  `status=not_ready` during drain, with an empty managed pool, or when the default
  runtime is locally unavailable. The console can still load to import accounts.
- Readiness is explicitly local (`upstream_verified=false`). It does not call
  Cursor or prove credential validity, model access, quota, or upstream reachability.
  Those require a separate authenticated business check.

Compose restarts an exited process with `restart: unless-stopped`. Its default
`GATEWAY_STOP_GRACE_PERIOD=61m` covers `RUN_DEADLINE_MS=3600000` plus the final
10-second socket close window. If the run deadline changes, keep the stop grace
period longer than that total. `docker stop --time` can override the allowance;
an earlier forced stop may interrupt active work.

After building, `node tests/deployment/node-smoke.mjs` checks the packaged Node
service with temporary state and synthetic configuration. CI also starts the
built image through the credential-free container smoke before release.

## Request capacity and timing

The default limits are development admission settings, not measured Cursor account
capacity. Tune them using representative load, error rates, latency, and process
memory; increasing the number of accounts does not raise the global limit.
Compose forwards the settings below from its environment or `.env` file.

| Setting | Default | Meaning |
|---|---:|---|
| `GLOBAL_ACTIVE_RUNS` | 4 | New execution admission across this process |
| `PER_CREDENTIAL_ACTIVE_RUNS` | 2 | New execution admission per credential and runtime profile |
| `MAX_AWAITING_SESSIONS` | 32 | Reject new sessions when this many are already waiting for tools |
| `FIRST_EVENT_TIMEOUT_MS` | 40000 | Sand grant/SDK startup plus the remaining first-event wait |
| `TOOL_BATCH_SETTLE_MS` | 1500 | Wait after the last tool callback to collect a complete batch |
| `CATALOG_CACHE_MS` | 300000 | Fresh model catalog TTL, starting at successful refresh completion |
| `CATALOG_REFRESH_TIMEOUT_MS` | 5000 | Maximum wait for a shared model catalog refresh |
| `CATALOG_RETRY_MS` | 5000 | Minimum retry interval after catalog failure |
| `CATALOG_MAX_STALE_MS` | 300000 | Additional stale fallback window after fresh TTL; 0 disables it |

Active admission counts `creating`, `running`, and `resuming`. A tool wait releases
the active slot while retaining the SDK Run/Agent and pending callbacks. Live tool
results can resume an already accepted Run even at capacity, including during
drain. Thus these settings are admission thresholds, not hard bounds on every
instantaneous state count. New requests over capacity receive `429` immediately;
there is no gateway waiting queue.

When SDK startup is interrupted, the same logical request cannot start again
until the original operation and its late resource cleanup settle. Pending startup
work retains its admission budget during this period. A cleanup failure leaves
that retry blocked because cancellation was not confirmed; starting another Run
would risk overlapping upstream execution.

The SDK model-list API has no cancellation signal. After a refresh timeout, later
requests reuse its failure/stale result without starting overlapping queries for
that credential. A permanently hung query requires its transport to settle or a
gateway restart before another refresh can start. Stale fallback always expires
at the configured age; it cannot extend indefinitely through repeated failures.

Inference and compact endpoints emit one numeric `request completed` log with
`request_id`, protocol `path`, `http_status`, `outcome`, and `duration_ms`.
`first_write_ms` is included only if a response body was written; it measures the
first local HTTP write, including SSE lifecycle frames, and is not model TTFT or
client-observed network latency. Client disconnects are recorded as `499` without
inventing a first-write time. Request and response bodies are not logged.

## GHCR releases

An approved `v<package-version>` tag runs the release workflow. It re-runs the
deterministic gate, secret scan, and critical-image vulnerability scan, then
publishes `linux/amd64` and `linux/arm64` images with OCI provenance and SBOM
attestations. The generated GitHub Release includes `image-digest.txt` so an
operator can deploy an immutable reference:

The `zhls-ayl` image examples below become usable only after an independently
maintained version has been published and its digest recorded in the Release.
Until then, use the local Compose build described above.

The runtime stage is a pinned non-root distroless Node 22 / Debian 13 image. It contains no
shell, package manager, or npm CLI; production dependencies are pruned in the
build stage and copied into the runtime image.

```bash
docker pull ghcr.io/zhls-ayl/cursor-sdk2api@sha256:<digest>
docker run -d -p 127.0.0.1:8080:8080 \
  --env-file .env -e HOST=0.0.0.0 -e PORT=8080 -e STATE_DIR=/data \
  --restart unless-stopped --stop-timeout 3660 \
  -v cursor-sdk2api-data:/data \
  ghcr.io/zhls-ayl/cursor-sdk2api@sha256:<digest>
```

Source changes and a green workflow do not mean an image exists. Creating the
tag and GitHub Release remains a separate maintainer action.

The original repository's `v0.1.0` source Release predates this GHCR workflow and has no
container asset. Before a later approved release, bump `package.json`, create
the matching new tag, verify the GHCR package is public, and prove an
unauthenticated pull by digest.

For a two-service new-api example, see
[`NEW_API_INTEGRATION.md`](NEW_API_INTEGRATION.md).

## Outbound proxy

The official SDK does not automatically inherit the host proxy. When
`HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is present (uppercase or lowercase),
the gateway routes both SDK data planes: Agent runs switch to HTTP/1.1 through
`proxy-agent`, and catalog/account fetches use Undici's environment proxy
dispatcher. `NO_PROXY` is honored. Only `http://` and `https://` proxy URLs are
accepted; SOCKS/PAC configurations fail closed. Health reports only
`proxy_configured`, `agent_transport`, and `fetch_transport`; URLs and
credentials are never exposed.

For Docker Desktop, point at a host proxy with `host.docker.internal`, for
example `HTTPS_PROXY=http://host.docker.internal:7890`. `127.0.0.1` inside the
container is the container itself.

## State directory

Set `STATE_DIR` for:

- official `@cursor/sdk` `JsonlLocalAgentStore` (`$STATE_DIR/sdk-store/<credential-fingerprint>`)
- gateway lineage metadata (`$STATE_DIR/lineage`, mode `0700` / files `0600`)

Host / local-dev default (no `STATE_DIR`) is a process temp path: `$TMPDIR/cursor-sdk2api/state`. The container **image** and `docker-compose.yml` default `STATE_DIR` to `/data` and compose declares a named volume. A bare `docker run` without `-e STATE_DIR` still gets `/data` from the image `ENV`.

Lineage schema v2 stores only session id, SDK agent id, credential fingerprint, model and explicit model parameters, canonical session-policy and executable-tool-catalog digests, state, pending tool ids and names, optional result digest, and timestamps. It does not store API keys, prompts, tool schemas/args/results, or assistant bodies. Older/incomplete lineage is quarantined and fails closed. Pending tool results can resume the persisted SDK Agent after restart when the client resends the exact tool catalog and pending id batch. Assistant replay bodies are **not** persisted, so duplicate-same replay after a later restart is still unavailable.

Session/registry TTL and the periodic sweep share the same clock. Completed and recoverable pending lineage expire with `SESSION_TTL_MS` (default 30 minutes), then they are deleted. Graceful shutdown does not delete recoverable lineage.

Completed follow-up with `x-cursor-session-id` can `Agent.resume` within the session TTL if credential and model match. Pending callback Promises themselves are not serialized; after restart the gateway resumes the persisted SDK Agent and injects the exact host tool-result batch after validating credential, model, catalog, and ids.

## Unified gateway key and BYOK

- BYOK: clients send a Cursor API key. Suitable for a trusted local sidecar.
- Managed pool: set `AUTH_MODE=managed` and `GATEWAY_ACCESS_KEY`, then import one or more Cursor keys in `/console/`. `CURSOR_API_KEY` is optional and only seeds the persistent pool.
- New sessions use model-aware round-robin across compatible accounts. Tool continuation, completed follow-up, and exact persisted restart recovery stay bound to the original credential fingerprint. Before semantic output, managed mode may try one alternate compatible account. If the original account is removed, a self-contained tool transcript may cold-branch to another compatible account.

BYOK credentials share the gateway process and capacity limits, but their official SDK stores and empty workspace directories are separated by credential fingerprint. This is process-local tenant isolation, not a claim of hardened hostile multi-tenant hosting; public Internet deployment still requires TLS, access controls, encrypted state, monitoring, and an explicit operator threat model.

## Drain and upgrade

In-process SDK Run handles and pending tool Promises cannot move to another process.

1. Stop sending new sessions to the old instance (`SIGTERM` starts drain).
2. Keep routing existing tool-result traffic to the same instance (sticky ownership).
3. Wait until active sessions reach zero or the drain deadline.
4. Then replace the process. Completed lineage and exact pending-tool metadata under `STATE_DIR` survive; live callback Promises do not. A restarted owner resumes the persisted Agent with the validated result batch rather than reusing the lost Promise.

A replica without the original live handle first tries persisted lineage. If that is unavailable, it may cold-branch only from a complete transcript with an exact latest tool batch; otherwise it returns `409 cursor_session_lost` rather than an empty success.

Completed follow-up after restart requires the same `STATE_DIR` volume, `x-cursor-session-id`, and the original account still present in the pool.

## Resource defaults

Development defaults: 4 global active runs, 2 per credential, 30 minute awaiting TTL, 10 minute replay TTL, 60 minute run deadline, and 40 seconds to the first SDK event.
