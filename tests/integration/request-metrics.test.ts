import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test.each([
  ["/v1/messages", false], ["/v1/messages", true],
  ["/v1/chat/completions", false], ["/v1/chat/completions", true],
  ["/v1/responses", false], ["/v1/responses", true],
] as const)("%s stream=%s emits one content-free HTTP timing receipt", async (path, stream) => {
  ctx = await startTestApp({ captureLogs: true });
  const content = "private-request-timing-canary";
  const body = path === "/v1/responses"
    ? { model: "composer-2.5", input: content, stream }
    : { model: "composer-2.5", max_tokens: 64, messages: [{ role: "user", content }], stream };
  const response = await api(ctx, path, { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  await response.text();
  const receipts = ctx.logs.map((line) => JSON.parse(line)).filter((entry) => entry.message === "request completed");
  expect(receipts).toHaveLength(1);
  expect(receipts[0].fields).toEqual({
    request_id: response.headers.get("x-request-id"),
    path, http_status: 200, outcome: "finished",
    duration_ms: expect.any(Number), first_write_ms: expect.any(Number),
  });
  expect(receipts[0].fields.first_write_ms).toBeLessThanOrEqual(receipts[0].fields.duration_ms);
  expect(ctx.logs.join("\n")).not.toContain(content);
  expect(ctx.logs.join("\n")).not.toContain("test-key-a");
});

test("capacity rejection has an HTTP timing receipt without an SDK execution", async () => {
  ctx = await startTestApp({ captureLogs: true, config: { globalActiveRuns: 0 } });
  const response = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 64, messages: [{ role: "user", content: "busy" }] }),
  });
  expect(response.status).toBe(429);
  await response.text();
  const receipts = ctx.logs.map((line) => JSON.parse(line)).filter((entry) => entry.message === "request completed");
  expect(receipts).toHaveLength(1);
  expect(receipts[0].fields).toMatchObject({ http_status: 429, outcome: "finished" });
  expect(ctx.sdk.createCalls).toHaveLength(0);
});
