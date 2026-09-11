import { afterEach, expect, test, vi } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("health reports runtime capability truth without account data", async () => {
  ctx = await startTestApp({
    config: {
      capabilities: {
        messages: true,
        count_tokens: true,
        chat_completions: true,
        responses: true,
        streaming: true,
        thinking: true,
        images: true,
        tools: true,
        parallel_tools: true,
        replay: true,
        agent_resume: true,
        pending_tool_restart_resume: false,
        streaming_impl: "sdk_onDelta",
        store_backend: "jsonl",
      },
    },
  });
  const res = await fetch(`${ctx.url}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    status: string;
    service: string;
    version: string;
    sdk_version: string;
    runtime: string;
    network: { proxy_configured: boolean; agent_transport: string; fetch_transport: string };
    capabilities: Record<string, boolean>;
    verification: Record<string, unknown>;
  };
  expect(body.status).toBe("ok");
  expect(body.service).toBe("cursor-sdk2api");
  expect(body.version).toBe(ctx.app.config.version);
  expect(body.sdk_version).toBe("1.0.30");
  expect(body.runtime).toBe("local");
  expect(body.network).toEqual({
    proxy_configured: ctx.app.config.proxyConfigured,
    agent_transport: ctx.app.config.agentTransport,
    fetch_transport: ctx.app.config.fetchTransport,
  });
  expect(body.capabilities).toMatchObject({
    messages: true,
    count_tokens: true,
    chat_completions: true,
    responses: true,
    streaming: true,
    thinking: true,
    images: true,
    tools: true,
    parallel_tools: true,
    agent_resume: true,
    pending_tool_restart_resume: false,
    transcript_tool_recovery: true,
    stale_auth_recovery: true,
    managed_account_failover: true,
    streaming_impl: "sdk_onDelta",
    store_backend: "jsonl",
  });
  expect(body.verification).toMatchObject({
    live_smoke: false,
    streaming: "sdk_onDelta",
    thinking: "implemented_unverified_live",
    images: "implemented_unverified_live",
    parallel_tools: "implemented_unverified_live",
    chat_completions: "contract_tested_unverified_live",
    responses: "contract_tested_unverified_live",
  });
  expect(body.verification).not.toHaveProperty("contract_tests");
  expect(JSON.stringify(body)).not.toContain("spending");
  expect(JSON.stringify(body)).not.toContain("email");
  expect(JSON.stringify(body)).not.toMatch(/\/Users\/|node_modules|STATE_DIR|sand-sdk/);
  const profiles = (body as { profiles?: { default?: string; sdk?: { ready?: boolean }; sand?: { ready?: boolean; sdk_version?: string; patch_contract_version?: string } } }).profiles;
  expect(profiles?.default).toBe("sdk");
  expect(profiles?.sdk?.ready).toBe(true);
  expect(profiles?.sand?.sdk_version).toBe("1.0.30");
  expect(profiles?.sand?.patch_contract_version).toBe("1.0.30");
  expect(typeof profiles?.sand?.ready).toBe("boolean");
});

test("health capabilities follow runtime config, not marketing constants", async () => {
  ctx = await startTestApp({
    config: {
      capabilities: {
        messages: true,
        count_tokens: true,
        chat_completions: false,
        responses: false,
        streaming: false,
        thinking: false,
        images: false,
        tools: true,
        parallel_tools: false,
        replay: false,
        agent_resume: false,
        pending_tool_restart_resume: false,
      },
    },
  });
  const body = (await (await fetch(`${ctx.url}/health`)).json()) as {
    capabilities: Record<string, boolean>;
  };
  expect(body.capabilities.streaming).toBe(false);
  expect(body.capabilities.parallel_tools).toBe(false);
  expect(body.capabilities.pending_tool_restart_resume).toBe(false);
});

test("empty managed pools are not ready while liveness and account import remain available", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "test-gateway", managedCursorKey: undefined },
  });
  const health = await fetch(`${ctx.url}/health`);
  expect(health.status).toBe(503);
  expect(await health.json()).toMatchObject({
    status: "not_ready",
    readiness: {
      accepting_sessions: false,
      shutting_down: false,
      scope: "local",
      upstream_verified: false,
      default_profile_ready: true,
      credential_pool_ready: false,
      reasons: ["cursor_account_pool_empty"],
    },
  });
  expect((await fetch(`${ctx.url}/livez`)).status).toBe(200);
  const imported = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "test-imported-cursor-key" }),
  });
  expect(imported.status).toBe(201);
  const ready = await fetch(`${ctx.url}/health`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({
    status: "ok",
    readiness: { credential_pool_ready: true, reasons: [], upstream_verified: false },
  });
  expect(ctx.sdk.listModelsCalls).toBe(0);
  expect(ctx.sdk.getAccountCalls).toBe(0);
  expect(ctx.sdk.createCalls).toHaveLength(0);
  expect(ctx.sdk.credentialProbeCalls).toHaveLength(0);
});

test("draining withdraws readiness but keeps liveness available", async () => {
  ctx = await startTestApp();
  ctx.app.beginShutdown();
  const response = await fetch(`${ctx.url}/health`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    status: "not_ready",
    readiness: {
      accepting_sessions: false,
      shutting_down: true,
      reasons: ["gateway_draining"],
    },
  });
  const live = await fetch(`${ctx.url}/livez`);
  expect(live.status).toBe(200);
  expect(await live.json()).toEqual({ status: "ok", service: "cursor-sdk2api" });
});

test.each(["sdk", "sand"] as const)("unavailable default %s runtime is not ready", async (profile) => {
  ctx = await startTestApp({
    sdk: { sdkVersion: profile === "sdk" ? "unavailable" : "1.0.30" },
    config: {
      runtimePolicy: { defaultProfile: profile, allowRequestOverride: false, hostedSearchMode: "off" },
    },
    sandHealth: {
      ready: false,
      sdk_version: "1.0.30",
      patch_contract_version: "1.0.30",
      reason: "version_mismatch",
    },
  });
  const response = await fetch(`${ctx.url}/health`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    status: "not_ready",
    profiles: { default: profile, [profile]: { ready: false } },
    readiness: {
      default_profile_ready: false,
      reasons: [`${profile}_runtime_unavailable`],
      upstream_verified: false,
    },
  });
  expect((await fetch(`${ctx.url}/livez`)).status).toBe(200);
});

test("optional unavailable Sand does not withdraw default SDK readiness", async () => {
  ctx = await startTestApp({
    sandHealth: {
      ready: false,
      sdk_version: "1.0.30",
      patch_contract_version: "1.0.30",
      reason: "version_mismatch",
    },
  });
  const response = await fetch(`${ctx.url}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "ok",
    profiles: { sdk: { ready: true }, sand: { ready: false } },
    readiness: { default_profile_ready: true, reasons: [] },
  });
});

test("unreadable managed account state reports local unavailability without leaking file errors", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "test-gateway", managedCursorKey: undefined },
  });
  vi.spyOn(ctx.app.accounts, "list").mockImplementation(() => {
    throw new Error("private-account-file-error-canary");
  });
  const response = await fetch(`${ctx.url}/health`);
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body).toMatchObject({
    status: "not_ready",
    readiness: {
      accepting_sessions: false,
      credential_pool_ready: false,
      reasons: ["cursor_account_store_unavailable"],
    },
  });
  expect(JSON.stringify(body)).not.toContain("private-account-file-error-canary");
  expect((await fetch(`${ctx.url}/livez`)).status).toBe(200);
});
