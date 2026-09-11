import { afterEach, expect, test } from "vitest";
import { credentialFingerprint } from "../../src/digest.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

const managed = { authMode: "managed" as const, gatewayAccessKey: "gateway-key", managedCursorKey: undefined };
const models = { ok: true as const, models: [{ id: "composer-2.5" }, { id: "grok-4.6" }] };
const initial = { model: "composer-2.5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] };

async function setup(options: Parameters<typeof startTestApp>[0] = {}): Promise<TestContext> {
  ctx = await startTestApp({ ...options, config: { ...managed, ...options.config }, sdk: { models, ...options.sdk } });
  ctx.app.accounts.add("cursor-a");
  await new Promise((resolve) => setTimeout(resolve, 2));
  ctx.app.accounts.add("cursor-b");
  return ctx;
}

function post(body: unknown = initial, headers?: Record<string, string>) {
  return api(ctx!, "/v1/messages", { apiKey: "gateway-key", method: "POST", headers, body: JSON.stringify(body) });
}

function follow(assistant: unknown, next = "next", extras: Record<string, unknown> = {}) {
  return {
    ...initial,
    messages: [...initial.messages, { role: "assistant", content: assistant }, { role: "user", content: next }],
    ...extras,
  };
}

async function firstTurn() {
  const first = await post();
  expect(first.status).toBe(200);
  return await first.json() as { id: string; content: Array<{ type: string; text?: string }> };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for managed routing state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("headerless managed successor keeps its credential and sends only the current turn", async () => {
  await setup({ sdk: { scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]] } });
  const first = await firstTurn();
  const next = await post(follow(first.content));
  expect(next.status).toBe(200);
  expect(ctx!.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a"]);
  expect(ctx!.sdk.resumeCalls).toHaveLength(0);
  expect(ctx!.sdk.agents[0]!.runs).toHaveLength(2);
  expect(ctx!.sdk.agents[0]!.lastSend!.text).toBe("next");

  const independent = await post({ ...initial, messages: [{ role: "user", content: "independent" }] });
  expect(independent.status).toBe(200);
  expect(ctx!.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);
});

test("managed duplicate replay stays on its owner even when that account is full", async () => {
  await setup({ config: { perCredentialActiveRuns: 1 } });
  const first = await firstTurn();
  ctx!.app.registry.create({
    credentialFingerprint: credentialFingerprint("cursor-a"), modelId: "composer-2.5",
    sessionPolicyFingerprint: "a".repeat(64), executableToolCatalogFingerprint: "b".repeat(64), runtimeProfile: "sdk",
  });
  const replay = await post();
  expect(replay.status).toBe(200);
  expect((await replay.json() as { id: string }).id).toBe(first.id);
  expect(ctx!.sdk.createCalls).toHaveLength(1);
});

test("simultaneous managed duplicates share one SDK execution across account selection", async () => {
  await setup({ config: { perCredentialActiveRuns: 1 }, sdk: { scripts: [[{ type: "text", chunks: ["first", "last"], pauseBetweenMs: 60 }]] } });
  let release!: () => void;
  let arrivals = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const handle = ctx!.app.coordinator.handleMessages.bind(ctx!.app.coordinator);
  ctx!.app.coordinator.handleMessages = async (...args) => {
    arrivals += 1;
    await pending;
    return handle(...args);
  };
  const responses = Promise.all([post(), post()]);
  try {
    await waitFor(() => arrivals === 2);
    expect(ctx!.app.ordinaryJournal.counts().total).toBe(0);
  } finally {
    release();
  }
  const [left, right] = await responses;
  expect([left.status, right.status]).toEqual([200, 200]);
  expect((await left.json() as { id: string }).id).toBe((await right.json() as { id: string }).id);
  expect(ctx!.sdk.createCalls).toHaveLength(1);
  expect(ctx!.sdk.agents[0]!.runs).toHaveLength(1);
});

test("a running managed duplicate joins its owner before capacity filtering", async () => {
  await setup({ config: { perCredentialActiveRuns: 1 }, sdk: { scripts: [[{ type: "text", chunks: ["first", "last"], pauseBetweenMs: 90 }]] } });
  const running = post();
  await waitFor(() => ctx!.sdk.agents[0]?.runs.length === 1);
  const repeated = post();
  const [left, right] = await Promise.all([running, repeated]);
  expect([left.status, right.status]).toEqual([200, 200]);
  expect((await left.json() as { id: string }).id).toBe((await right.json() as { id: string }).id);
  expect(ctx!.sdk.createCalls).toHaveLength(1);
});

test("restart uses the ordinary journal owner for exact successor and fails closed on old duplicate", async () => {
  await setup();
  await post({ ...initial, messages: [{ role: "user", content: "warmup" }] });
  const first = await firstTurn();
  expect(ctx!.sdk.createCalls[1]!.apiKey).toBe("cursor-b");
  const agentId = ctx!.sdk.agents[1]!.agentId;
  const stateDir = ctx!.app.config.stateDir;
  await closeTestApp(ctx!);
  ctx = undefined;
  ctx = await startTestApp({ config: { ...managed, stateDir }, sdk: { models } });
  const duplicate = await post();
  expect(duplicate.status).toBe(409);
  expect(ctx.sdk.createCalls).toHaveLength(0);
  const resumed = await post(follow(first.content));
  expect(resumed.status).toBe(200);
  expect(ctx.sdk.lastResume).toMatchObject({ apiKey: "cursor-b", agentId });
  expect(ctx.sdk.agents[0]!.lastSend!.text).toBe("next");
});

test.each(["model", "tools", "history", "system", "profile"] as const)(
  "managed %s mismatch cold-builds without resuming an unrelated account", async (mismatch) => {
    await setup({ config: { runtimePolicy: { defaultProfile: "sdk", allowRequestOverride: true, hostedSearchMode: "off" } }, assertSandAccess: async () => undefined });
    const first = await firstTurn();
    const body = follow(first.content);
    let headers: Record<string, string> | undefined;
    if (mismatch === "model") body.model = "grok-4.6";
    if (mismatch === "tools") Object.assign(body, { tools: [weatherTool()] });
    if (mismatch === "history") body.messages[0] = { role: "user", content: "different prior user" };
    if (mismatch === "system") Object.assign(body, { system: "different policy" });
    if (mismatch === "profile") headers = { "x-cursor-runtime-profile": "sand" };
    const response = await post(body, headers);
    expect(response.status).toBe(200);
    expect(ctx!.sdk.createCalls).toHaveLength(2);
    expect(ctx!.sdk.resumeCalls).toHaveLength(0);
    expect(ctx!.sdk.agents[0]!.runs).toHaveLength(1);
    expect(ctx!.sdk.agents[1]!.lastSend!.text).toContain("next");
    expect(ctx!.sdk.agents[1]!.lastSend!.text).toContain(mismatch === "history" ? "different prior user" : "hello");
  },
);

test("a fork cold-builds instead of appending to its already advanced managed Agent", async () => {
  await setup();
  const first = await firstTurn();
  expect((await post(follow(first.content, "branch one"))).status).toBe(200);
  expect((await post(follow(first.content, "branch two"))).status).toBe(200);
  expect(ctx!.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx!.sdk.agents[0]!.runs).toHaveLength(2);
  expect(ctx!.sdk.agents[1]!.lastSend!.text).toContain("hello");
  expect(ctx!.sdk.agents[1]!.lastSend!.text).toContain("branch two");
});

test("full managed transcript cold-builds on another account if its owner was removed", async () => {
  await setup();
  const first = await firstTurn();
  const owner = ctx!.app.accounts.findByFingerprint(credentialFingerprint("cursor-a"))!;
  ctx!.app.accounts.remove(owner.id);
  expect((await post(follow(first.content))).status).toBe(200);
  expect(ctx!.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx!.sdk.resumeCalls).toHaveLength(0);
  expect(ctx!.sdk.agents[1]!.lastSend!.text).toContain("hello");
});

test("full managed successor preserves pre-semantic failover when its owner is full", async () => {
  await setup({ config: { perCredentialActiveRuns: 1 } });
  const first = await firstTurn();
  ctx!.app.registry.create({
    credentialFingerprint: credentialFingerprint("cursor-a"), modelId: "composer-2.5",
    sessionPolicyFingerprint: "a".repeat(64), executableToolCatalogFingerprint: "b".repeat(64), runtimeProfile: "sdk",
  });
  const response = await post(follow(first.content));
  expect(response.status).toBe(200);
  const completed = await response.json() as { id: string };
  expect(ctx!.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx!.sdk.agents[0]!.runs).toHaveLength(1);
  expect(ctx!.sdk.agents[1]!.lastSend!.text).toContain("hello");
  const repeated = await post(follow(first.content));
  expect(repeated.status).toBe(200);
  expect((await repeated.json() as { id: string }).id).toBe(completed.id);
  expect(ctx!.sdk.createCalls).toHaveLength(2);
});

test("pre-semantic failure on a reused managed Agent cold-builds the full transcript on an alternate", async () => {
  await setup({ sdk: { agentScripts: [
    [[{ type: "text", chunks: ["first"] }], [{ type: "send-error", message: "provider unavailable" }]],
    [[{ type: "text", chunks: ["recovered"] }]],
  ] } });
  const first = await firstTurn();
  const response = await post(follow(first.content));
  expect(response.status).toBe(200);
  expect(ctx!.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx!.sdk.agents[1]!.lastSend!.text).toContain("hello");
});

test("managed capacity filtering uses the requested runtime profile", async () => {
  await setup({ config: { perCredentialActiveRuns: 1, runtimePolicy: { defaultProfile: "sdk", allowRequestOverride: true, hostedSearchMode: "off" } }, assertSandAccess: async () => undefined });
  ctx!.app.accounts.remove(ctx!.app.accounts.findByFingerprint(credentialFingerprint("cursor-b"))!.id);
  ctx!.app.registry.create({
    credentialFingerprint: credentialFingerprint("cursor-a"), modelId: "composer-2.5",
    sessionPolicyFingerprint: "a".repeat(64), executableToolCatalogFingerprint: "b".repeat(64), runtimeProfile: "sdk",
  });
  const response = await post(initial, { "x-cursor-runtime-profile": "sand" });
  expect(response.status).toBe(200);
  expect(ctx!.sdk.lastCreate).toMatchObject({ apiKey: "cursor-a", runtimeProfile: "sand" });
});

test("ordinary transcript ownership cannot bypass managed gateway authentication", async () => {
  await setup();
  const first = await firstTurn();
  const unauthorized = await api(ctx!, "/v1/messages", { apiKey: "cursor-a", method: "POST", body: JSON.stringify(follow(first.content)) });
  expect(unauthorized.status).toBe(401);
  expect(ctx!.sdk.createCalls).toHaveLength(1);
  expect(ctx!.sdk.agents[0]!.runs).toHaveLength(1);
});

test.each(["create", "send"] as const)("managed duplicate cannot switch accounts while timed-out SDK %s is pending", async (stage) => {
  await setup({ config: { firstEventTimeoutMs: 30 } });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const create = ctx!.sdk.createAgent.bind(ctx!.sdk);
  let starts = 0;
  let sends = 0;
  ctx!.sdk.createAgent = async (input) => {
    starts += 1;
    if (starts === 1 && stage === "create") await pending;
    const agent = await create(input);
    if (starts === 1 && stage === "send") {
      const send = agent.send.bind(agent);
      agent.send = async (value) => {
        sends += 1;
        await pending;
        return send(value);
      };
    }
    return agent;
  };
  try {
    const timedOut = await post();
    expect(timedOut.status).toBe(504);
    const duplicate = await post();
    expect(duplicate.status).toBe(504);
    expect(starts).toBe(1);
    expect(sends).toBe(stage === "send" ? 1 : 0);
    release();
    await waitFor(() => ctx!.sdk.agents[0]?.closed === true && (stage !== "send" || ctx!.sdk.agents[0]?.runs[0]?.cancelled === true));
    // Cleanup has settled before a new logical attempt may reach another SDK.
    const retried = await post();
    expect(retried.status).toBe(200);
    expect(starts).toBe(2);
  } finally {
    release();
  }
});

test("managed client disconnect during catalog lookup prevents SDK startup", async () => {
  await setup();
  let release!: () => void;
  let finished!: () => void;
  let closed!: () => void;
  let lookups = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const handled = new Promise<void>((resolve) => { finished = resolve; });
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  ctx!.sdk.listModels = async () => { lookups += 1; await pending; return models; };
  const handler = ctx!.app.handler;
  ctx!.app.handler = async (req, res) => {
    res.once("close", closed);
    try { await handler(req, res); } finally { finished(); }
  };
  const controller = new AbortController();
  const response = api(ctx!, "/v1/messages", {
    apiKey: "gateway-key", method: "POST", body: JSON.stringify(initial), signal: controller.signal,
  }).catch(() => undefined);
  try {
    await waitFor(() => lookups === 2);
    controller.abort();
    await response;
    await disconnected;
    release();
    await handled;
    expect(ctx!.sdk.createCalls).toHaveLength(0);
  } finally {
    release();
    controller.abort();
  }
});
