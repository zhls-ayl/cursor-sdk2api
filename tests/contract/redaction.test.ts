import { afterEach, expect, test } from "vitest";
import { assertNoSecretLeak, sanitize } from "../../src/log.js";
import { redactSecrets, sdkFailure, toOpenAIErrorBody, toPublicErrorBody } from "../../src/errors.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test("default logs do not contain credentials or tool payloads", async () => {
  const canaryKey = "sk-canary-SECRET-123456789";
  const canaryArg = "super-secret-tool-arg";
  ctx = await startTestApp({
    captureLogs: true,
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: canaryArg } }] },
          { type: "text", chunks: ["ok"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    apiKey: canaryKey,
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "do not log this prompt" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  await api(ctx, "/v1/messages", {
    apiKey: canaryKey,
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "secret-result" }] }],
    }),
  });
  const dumped = ctx.logs.join("\n");
  assertNoSecretLeak(dumped, [canaryKey, canaryArg, "secret-result", "do not log this prompt"]);
  expect(dumped).not.toContain(canaryKey);
});

test("error envelope never echoes the API key", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/messages", {
    apiKey: "sk-visible-should-not-echo",
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", messages: [] }),
  });
  const raw = await res.text();
  expect(raw).not.toContain("sk-visible-should-not-echo");
  expect(raw).toContain("request_id");
});

test.each(["sk-stream-secret-ABCDEFGH", "crsr_synthetic_stream_canary_12345678"])("mid-stream SDK errors redact secret-like text (%s)", async (canary) => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["partial"] }, { type: "error", message: `failed ${canary}` }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "go" }],
    }),
  });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("event: error");
  expect(body).not.toContain(canary);
  expect(body).toContain("[redacted]");
});

test("bare Cursor credentials are redacted from error envelopes and nested log fields", () => {
  const canary = "crsr_synthetic_redaction_canary_12345678";
  const raw = `upstream rejected (${canary}), request failed`;
  expect(redactSecrets(raw)).toBe("upstream rejected ([redacted]), request failed");
  const error = sdkFailure(new Error(raw));
  const values = [
    toPublicErrorBody(error, "synthetic-request"),
    toOpenAIErrorBody(error, "synthetic-request"),
    sanitize({ error: { detail: raw }, attempts: [raw] }),
  ];
  for (const value of values) {
    expect(JSON.stringify(value)).not.toContain(canary);
    expect(JSON.stringify(value)).toContain("[redacted]");
  }
});

test("proxy URL credentials are redacted from public errors", () => {
  const raw = "proxy failed at http://proxy-user:proxy-password@127.0.0.1:7890";
  const redacted = redactSecrets(raw);
  expect(redacted).not.toContain("proxy-user");
  expect(redacted).not.toContain("proxy-password");
  expect(redacted).toContain("http://[redacted]@");
});
