import { afterEach, expect, test, vi } from "vitest";
import { getHealth } from "../../web/src/api.js";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

const nativeFetch = globalThis.fetch;
let ctx: TestContext | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test("console keeps the actual readiness payload through empty-pool and drain 503s", async () => {
  ctx = await startTestApp({ config: { authMode: "managed", gatewayAccessKey: "console-health-synthetic" } });
  const origin = ctx.url;
  vi.stubGlobal("fetch", (path: string) => nativeFetch(`${origin}${path}`));

  const empty = await getHealth();
  expect(empty.status).toBe("not_ready");
  expect(empty.readiness.reasons).toContain("cursor_account_pool_empty");
  expect(empty.sdk_version).toBe("1.0.30");

  const account = ctx.app.accounts.add("console-health-synthetic-cursor");
  expect((await getHealth()).status).toBe("ok");
  ctx.app.accounts.remove(account.id);
  expect((await getHealth()).status).toBe("not_ready");

  ctx.app.beginShutdown();
  expect((await getHealth()).readiness.reasons).toContain("gateway_draining");
  expect(ctx.sdk.createCalls).toHaveLength(0);
});

test("console does not mistake a proxy 503 for a gateway readiness response", async () => {
  vi.stubGlobal("fetch", async () => new Response("Service unavailable", { status: 503 }));
  await expect(getHealth()).rejects.toThrow("Service unavailable");
});
