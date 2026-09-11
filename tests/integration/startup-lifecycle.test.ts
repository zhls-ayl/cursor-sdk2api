import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (!ctx) return;
  for (const session of ctx.app.registry.sessions.values()) ctx.app.registry.forget(session, "test_cleanup");
  ctx.server.closeAllConnections();
  await closeTestApp(ctx);
  ctx = undefined;
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const body = (text = "startup") => JSON.stringify({
  model: "composer-2.5",
  max_tokens: 16,
  messages: [{ role: "user", content: text }],
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
  expect(predicate()).toBe(true);
}

test.each([false, true])("disconnect during create closes the late Agent without Send (ledger %s)", async (runtimeLedgerV2) => {
  ctx = await startTestApp({ config: { runtimeLedgerV2, firstEventTimeoutMs: 5_000 } });
  const held = gate();
  const entered = gate();
  const create = ctx.sdk.createAgent.bind(ctx.sdk);
  ctx.sdk.createAgent = async (args) => {
    entered.resolve();
    await held.promise;
    return create(args);
  };
  const abort = new AbortController();
  const pending = api(ctx, "/v1/messages", { method: "POST", body: body(), signal: abort.signal }).catch(() => undefined);
  try {
    await entered.promise;
    abort.abort();
    await pending;
    await waitFor(() => ctx!.app.registry.activeCount() === 0);
    expect(ctx.sdk.agents).toHaveLength(0);
  } finally {
    held.resolve();
  }
  await waitFor(() => ctx!.sdk.agents[0]?.closed === true);
  expect(ctx.sdk.agents[0]?.sendCount).toBe(0);
});

test.each([false, true])("disconnect during pending Send cancels the late Run (ledger %s)", async (runtimeLedgerV2) => {
  ctx = await startTestApp({ config: { runtimeLedgerV2, firstEventTimeoutMs: 5_000 } });
  const held = gate();
  const entered = gate();
  const create = ctx.sdk.createAgent.bind(ctx.sdk);
  ctx.sdk.createAgent = async (args) => {
    const agent = await create(args);
    const send = agent.send.bind(agent);
    agent.send = async (args) => {
      const run = await send(args);
      entered.resolve();
      await held.promise;
      return run;
    };
    return agent;
  };
  const abort = new AbortController();
  const pending = api(ctx, "/v1/messages", { method: "POST", body: body(), signal: abort.signal }).catch(() => undefined);
  try {
    await entered.promise;
    const logicalKey = [...ctx.app.registry.sessions.values()][0]?.logicalKey;
    abort.abort();
    await pending;
    await waitFor(() => ctx!.app.registry.activeCount() === 0);
    expect(ctx.sdk.agents[0]?.closed).toBe(true);
    if (logicalKey) expect(ctx.app.ledger?.getRunByLogicalKey(logicalKey)).toBeUndefined();
  } finally {
    held.resolve();
  }
  await waitFor(() => ctx!.sdk.agents[0]?.runs[0]?.cancelled === true);
  expect(ctx.sdk.agents[0]?.runs[0]?.streamStarts).toBe(0);
});

test("HTTP startup timeout returns 504 before a blocked create resolves", async () => {
  const clock = new FakeClock();
  ctx = await startTestApp({ clock, config: { firstEventTimeoutMs: 50 } });
  const held = gate();
  const entered = gate();
  const create = ctx.sdk.createAgent.bind(ctx.sdk);
  ctx.sdk.createAgent = async (args) => { entered.resolve(); await held.promise; return create(args); };
  const pending = api(ctx, "/v1/messages", { method: "POST", body: body() });
  try {
    await entered.promise;
    clock.advance(50);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { type: "cursor_timeout" } });
    expect(ctx.app.registry.activeCount()).toBe(0);
  } finally {
    held.resolve();
  }
  await waitFor(() => ctx!.sdk.agents[0]?.closed === true);
  expect(ctx.sdk.agents[0]?.sendCount).toBe(0);
});

test("completed keep-alive requests remove their disconnect listeners", async () => {
  ctx = await startTestApp();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const sockets = new Set<Socket>();
  const listenerCounts: number[] = [];
  ctx.server.on("request", (req) => { sockets.add(req.socket); });
  try {
    for (let i = 0; i < 16; i += 1) {
      const payload = body(`keepalive-${i}`);
      await new Promise<void>((resolve, reject) => {
        const req = request(`${ctx!.url}/v1/messages`, {
          method: "POST",
          agent,
          headers: {
            authorization: "Bearer test-key-a",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        }, (res) => {
          if (res.statusCode !== 200) reject(new Error(`unexpected status ${res.statusCode}`));
          res.resume();
          res.once("end", resolve);
        });
        req.once("error", reject);
        req.end(payload);
      });
      listenerCounts.push([...sockets][0]!.listenerCount("close"));
    }
    expect(sockets.size).toBe(1);
    expect(new Set(listenerCounts).size).toBe(1);
    expect(listenerCounts[0]).toBeLessThan(3);
  } finally {
    agent.destroy();
  }
});

test("ledger-bound Run survives disconnect before its first semantic event and finalizes", async () => {
  ctx = await startTestApp({
    config: { runtimeLedgerV2: true, firstEventTimeoutMs: 5_000 },
    sdk: { scripts: [[{ type: "text", chunks: ["done"] }]], finalUsage: { inputTokens: 2, outputTokens: 3 } },
  });
  const held = gate();
  const create = ctx.sdk.createAgent.bind(ctx.sdk);
  ctx.sdk.createAgent = async (args) => {
    const agent = await create(args);
    const send = agent.send.bind(agent);
    agent.send = async (args) => {
      const run = await send(args);
      const stream = run.stream.bind(run);
      run.stream = async function* () { await held.promise; yield* stream(); };
      return run;
    };
    return agent;
  };
  const abort = new AbortController();
  const pending = api(ctx, "/v1/messages", { method: "POST", body: body(), signal: abort.signal }).catch(() => undefined);
  let runId: string | undefined;
  try {
    await waitFor(() => {
      runId = [...ctx!.app.registry.sessions.values()][0]?.ledgerRunId;
      return Boolean(runId);
    });
    abort.abort();
    await pending;
    await new Promise((done) => setTimeout(done, 20));
    expect(ctx.sdk.agents[0]?.runs[0]?.cancelled).toBe(false);
    expect(ctx.app.registry.activeCount()).toBe(1);
  } finally {
    held.resolve();
  }
  await waitFor(() => ctx!.app.ledger?.getReceiptByRunId(runId!)?.state === "finalized");
  expect(ctx.sdk.agents[0]?.runs[0]?.cancelled).toBe(false);
  expect(ctx.app.ledger?.getReceiptByRunId(runId!)?.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
});

test.each([false, true])("startup retry waits for pending Send and late cleanup (ordinary coordinator %s)", async (ordinaryTurnCoordinator) => {
  const clock = new FakeClock();
  ctx = await startTestApp({ clock, config: { firstEventTimeoutMs: 50, ordinaryTurnCoordinator } });
  const held = gate();
  const closing = gate();
  const entered = gate();
  const create = ctx.sdk.createAgent.bind(ctx.sdk);
  ctx.sdk.createAgent = async (args) => {
    const agent = await create(args);
    if (ctx!.sdk.agents.length > 1) return agent;
    const send = agent.send.bind(agent);
    const close = agent.close.bind(agent);
    agent.close = async () => { await closing.promise; await close(); };
    agent.send = async (args) => {
      const run = await send(args);
      entered.resolve();
      await held.promise;
      return run;
    };
    return agent;
  };
  const pending = api(ctx, "/v1/messages", { method: "POST", body: body() });
  try {
    await entered.promise;
    clock.advance(50);
    expect((await pending).status).toBe(504);
    const retry = await api(ctx, "/v1/messages", { method: "POST", body: body() });
    expect(retry.status).toBe(504);
    expect(ctx.sdk.agents).toHaveLength(1);
    expect(ctx.sdk.agents[0]?.sendCount).toBe(1);

    held.resolve();
    await waitFor(() => ctx!.sdk.agents[0]?.runs[0]?.cancelled === true);
    const beforeClose = await api(ctx, "/v1/messages", { method: "POST", body: body() });
    expect(beforeClose.status).toBe(504);
    expect(ctx.sdk.agents).toHaveLength(1);
  } finally {
    held.resolve();
    closing.resolve();
  }
  await new Promise<void>((done) => setImmediate(done));
  const afterClose = await api(ctx, "/v1/messages", { method: "POST", body: body() });
  expect(afterClose.status).toBe(200);
  expect(ctx.sdk.agents).toHaveLength(2);
  expect(ctx.sdk.agents[1]?.sendCount).toBe(1);
});

test.each([
  { limit: "global", stage: "create" },
  { limit: "global", stage: "send" },
  { limit: "credential", stage: "create" },
  { limit: "credential", stage: "send" },
])("unsettled $stage still occupies $limit capacity for different requests", async ({ limit, stage }) => {
  const clock = new FakeClock();
  ctx = await startTestApp({ clock, config: {
    firstEventTimeoutMs: 50,
    globalActiveRuns: limit === "global" ? 1 : 4,
    perCredentialActiveRuns: limit === "credential" ? 1 : 4,
  } });
  const held = gate();
  const entered = gate();
  const create = ctx.sdk.createAgent.bind(ctx.sdk);
  let creates = 0;
  ctx.sdk.createAgent = async (args) => {
    creates += 1;
    if (creates === 1 && stage === "create") { entered.resolve(); await held.promise; }
    const agent = await create(args);
    if (creates === 1 && stage === "send") {
      const send = agent.send.bind(agent);
      agent.send = async (args) => {
        const run = await send(args);
        entered.resolve();
        await held.promise;
        return run;
      };
    }
    return agent;
  };
  const pending = api(ctx, "/v1/messages", { method: "POST", body: body("first") });
  const otherKey = limit === "global" ? "test-key-b" : "test-key-a";
  try {
    await entered.promise;
    clock.advance(50);
    expect((await pending).status).toBe(504);
    for (let i = 0; i < 3; i += 1) {
      const next = await api(ctx, "/v1/messages", { method: "POST", body: body(`next-${i}`), apiKey: otherKey });
      expect(next.status).toBe(429);
      expect(await next.json()).toMatchObject({ error: { type: "rate_limited" } });
    }
    expect(creates).toBe(1);
  } finally {
    held.resolve();
  }
  await new Promise<void>((done) => setImmediate(done));
  const ready = await api(ctx, "/v1/messages", { method: "POST", body: body("after cleanup"), apiKey: otherKey });
  expect(ready.status).toBe(200);
  expect(creates).toBe(2);
});
