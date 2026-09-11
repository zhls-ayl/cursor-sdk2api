import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("models require auth", async () => {
  ctx = await startTestApp();
  const res = await fetch(`${ctx.url}/v1/models`);
  expect(res.status).toBe(401);
});

test("models preserve exact catalog ids and do not invent aliases", async () => {
  ctx = await startTestApp({
    sdk: {
      models: {
        ok: true,
        models: [
          {
            id: "claude-sonnet-4-6",
            displayName: "Sonnet 4.6",
            parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
          },
        ],
      },
    },
  });
  const res = await api(ctx, "/v1/models");
  const body = (await res.json()) as { data: Array<{ id: string }>; status: string };
  expect(res.status).toBe(200);
  expect(body.status).toBe("ok");
  expect(body.data.map((item) => item.id)).toEqual(["claude-sonnet-4-6"]);
  expect(JSON.stringify(body)).not.toContain("cursor/");
});

test("models degrade honestly when the SDK catalog is unavailable", async () => {
  ctx = await startTestApp({
    sdk: {
      models: { ok: false, reason: "cursor_models_list_unavailable", message: "no catalog" },
    },
  });
  const res = await api(ctx, "/v1/models");
  const body = (await res.json()) as {
    data: unknown[];
    status: string;
    reason: string;
    error: { type: string; code: string; message: string };
  };
  expect(res.status).toBe(503);
  expect(body.data).toEqual([]);
  expect(body.status).toBe("unavailable");
  expect(body.reason).toBe("cursor_models_list_unavailable");
  expect(body.error).toMatchObject({ type: "api_error", code: "cursor_upstream_error" });
});

test("stale catalog is marked after a live refresh failure", async () => {
  ctx = await startTestApp({
    config: { catalogCacheMs: 1 },
    sdk: {
      models: { ok: true, models: [{ id: "composer-2.5" }] },
    },
  });
  await api(ctx, "/v1/models");
  ctx.sdk.models = { ok: false, reason: "cursor_models_list_unavailable", message: "down" };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const res = await api(ctx, "/v1/models");
  const body = (await res.json()) as {
    status: string;
    cache: { stale: boolean };
    data: Array<{ id: string }>;
  };
  expect(res.status).toBe(200);
  expect(body.status).toBe("stale");
  expect(body.cache.stale).toBe(true);
  expect(body.data[0]?.id).toBe("composer-2.5");
});

test("catalog cache is scoped to credential fingerprint", async () => {
  ctx = await startTestApp({
    sdk: { models: { ok: true, models: [{ id: "only-for-a" }] } },
  });
  await api(ctx, "/v1/models", { apiKey: "key-a" });
  ctx.sdk.models = { ok: true, models: [{ id: "only-for-b" }] };
  const body = (await (await api(ctx, "/v1/models", { apiKey: "key-b" })).json()) as {
    data: Array<{ id: string }>;
  };
  expect(body.data[0]?.id).toBe("only-for-b");
});

test("catalog timeout returns a service error without declaring the credential invalid", async () => {
  ctx = await startTestApp({ config: { catalogRefreshTimeoutMs: 20 } });
  ctx.sdk.listModels = async () => new Promise(() => undefined);
  const catalog = await api(ctx, "/v1/models");
  expect(catalog.status).toBe(503);
  expect(await catalog.json()).toMatchObject({
    error: { type: "api_error", code: "cursor_upstream_error" },
    status: "unavailable",
    reason: "cursor_models_list_timeout",
    data: [],
    cache: { stale: false },
  });

  const inference = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
  });
  expect(inference.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.credentialProbeCalls).toHaveLength(0);
});

test("an available but empty SDK catalog remains a successful empty list", async () => {
  ctx = await startTestApp({ sdk: { models: { ok: true, models: [] } } });
  const res = await api(ctx, "/v1/models");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ object: "list", data: [], status: "ok", cache: { stale: false } });
  expect(body).not.toHaveProperty("error");
});

test.each([false, true])("managed catalog is 503 when no account provides a catalog (empty pool %s)", async (emptyPool) => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: { models: { ok: false, reason: "cursor_models_list_unavailable", message: "no catalog" } },
  });
  if (!emptyPool) ctx.app.accounts.add("synthetic-cursor-key");
  const res = await api(ctx, "/v1/models", { apiKey: "gateway-key" });
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({
    error: { type: "api_error", code: "cursor_upstream_error" },
    status: "unavailable",
    reason: emptyPool ? "cursor_account_pool_empty" : "cursor_models_list_unavailable",
    data: [],
    cache: { stale: false },
    account_pool_size: emptyPool ? 0 : 1,
  });
});

test("managed catalog retains available account models when another catalog fails", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: { modelsByApiKey: {
      "synthetic-a": { ok: false, reason: "cursor_models_list_unavailable", message: "no catalog" },
      "synthetic-b": { ok: true, models: [{ id: "composer-2.5" }] },
    } },
  });
  ctx.app.accounts.add("synthetic-a");
  ctx.app.accounts.add("synthetic-b");
  const res = await api(ctx, "/v1/models", { apiKey: "gateway-key" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok", data: [{ id: "composer-2.5" }], account_pool_size: 2 });
  expect(body).not.toHaveProperty("error");
});
